/*jslint node: true */

'use strict';

var Q = require('q');
var se = require('stream-extra');
var net = require('net');
var debug = require('debug')('pm-node');
var usage = require('usage');
var _ = require('underscore');
var spawn = require('child_process').spawn;
var os = require('os');
var path = require('path');

try {
  // load the heapdump module if installed
  require('heapdump');
} catch (e) {}

// private functions

// return a copy of all public properties of a procInfo object
var toPublicProcInfo = function(procInfo) {
  var publicInfo = _.extend({}, procInfo);
  if (publicInfo._proc) {
    delete publicInfo._proc;
  }

  return publicInfo;
};

// constructor
var PMNode = function(opts) {
  this.serverHost = opts.serverHost;
  this.serverPort = opts.serverPort;
  this.processes = [
    {
      name: 'pm-node',
      pid: process.pid,
      _proc: process,
      protected: true
    },
  ];
};

module.exports = PMNode;

// connect to the pm master server
PMNode.prototype.connect = function(opts) {
  opts = _.extend({
    ping: true,
    pingInterval: 30 * 1000,
  }, opts);

  if (this.rpc || this.rawSocket) {
    return new Q(new Error('client is conencted'));
  }

  var deferred = Q.defer();
  this.rawSocket = net.createConnection(
    this.serverPort,
    this.serverHost
  );
  this.rawSocket.once(
    'connect',
    this._onRawSocketConnection.bind(this)
  );
  this.rawSocket.once('connect', deferred.resolve);
  this.rawSocket.once('error', deferred.reject);
  this.rawSocket.once(
    'close',
    this._onRawSocketClose.bind(this)
  );
  if (!this.pingInterval && opts.ping) {
    this.pingInterval = setInterval(
      this._onPingInterval.bind(this),
      opts.pingInterval
    );
  }

  return deferred.promise;
};

// on server socket connected
PMNode.prototype._onRawSocketConnection = function() {
  debug('got raw socket to server');
  if (!this.rawSocket) {
    return debug(
      'ERROR: _onRawSocketConnection without socket'
    );
  }

  if (this.mux) {
    return debug(
      'ERROR: _onRawSocketConnection but mux is not null'
    );
  }

  if (this.rpc) {
    return debug(
      'ERROR: _onRawSocketConnection but rpc is not null'
    );
  }

  this.mux = new se.Mux(
    new se.Buffered(this.rawSocket, {lengthEncoding: 4})
  );
  this.mux.once('error', this._onMuxError.bind(this));
  var jsonStream = new se.JSON(this.mux);
  this.rpc = new se.RPC(jsonStream, this._getPublicMethod());
};

PMNode.prototype._onRawSocketClose = function() {
  debug('lost connection to server');
  this.mux = null;
  this.rpc = null;
  this.rawSocket = null;
};

PMNode.prototype._onMuxError = function(err) {
  debug('mux error: ' + err.message);
  this.mux = null;
  this.rpc = null;
  this.rawSocket = null;
};

// on ping interval
PMNode.prototype._onPingInterval = function() {
  if (this.rpc) {
    var time = new Date().getTime();
    this.rpc.call('loop', {time: time})
    .then(function(data) {
      if (data.time !== time) {
        debug('ERROR: loop time does not match');
      }

      var rTime = new Date().getTime();
      var latency = rTime - time;
      if (latency > 500) {
        debug(
          'got loop response with high latency ' +
          latency +
          'ms'
        );
      }
    });
  } else {
    debug('ping interval has no rpc ... reconnecting now');
    this.connect().then(function() {
      debug('reconnect successful');
    }).fail(function(err) {
      debug('can not reconnect: ' + err.message);
    }).done();
  }
};

// return the server methods for RPC.
PMNode.prototype._getPublicMethod = function() {
  return {
    getProcesses: this.getProcesses.bind(this),
    getInfo: this.getInfo.bind(this),
    spawn: this.spawn.bind(this),
    kill: this.kill.bind(this),
  };
};

// Start of public methods.

PMNode.prototype.getInfo = function() {
  debug('getInfo');
  return new Q({
    hostname: os.hostname(),
    type: os.type(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    uptime: os.uptime(),
    totalmem: os.totalmem(),
    cpus: os.cpus().map(function(cpu) {
      return {
        model: cpu.model,
        speed: cpu.speed,
      };
    }),
  });
};

PMNode.prototype.getProcesses = function() {
  debug('getProcesses');
  return Q.all(this.processes.map(function(info) {
    var deferred = Q.defer();
    usage.lookup(info.pid, function(err, result) {
      if (err) {
        deferred.reject(err);
      } else {
        deferred.resolve(
          _.extend({}, toPublicProcInfo(info), result)
        );
      }
    });

    return deferred.promise;
  }));
};

PMNode.prototype.spawn = function(opts) {
  opts = _.extend({
    args: [],
    promise: 'creation',
  }, opts);

  if (!opts.command) {
    debug('illigal spawn call: command missing!');
    return new Q(new Error('command is required'));
  }

  // validate the promise options.
  if (!_.contains(['creation', 'execution'], opts.promise)) {
    debug(
      'illigal spawn call: promise type ' +
      opts.promise + ' is not supported'
    );
    return new Q(new Error(
      'promise type ' + opts.promise + ' is not supported'
    ));
  }

  var name = opts.name || path.basename(opts.command);
  debug('starting ' + name + ' process');
  var proc;
  try {
    proc = spawn(opts.command, opts.args);
  } catch (err) {
    debug(name + ' process spwan error: ' + err.message);
    return new Q(err);
  }

  var procInfo = {
    _proc: proc, // private
    coreId: opts.coreId, // only for server
    name: name,
    pid: proc.pid,
    promise: opts.promise,
  };
  var processes = this.processes;
  processes.push(procInfo);

  // start of async handling
  var deferred = Q.defer();

  var masterRpc = this.rpc;

  var lastProcError = null;
  proc.on('error', function(err) {
    debug(name + ' process error: ' + err.message);

    // store the error that we can send it to the master in the close handler.
    lastProcError = err;
  });

  proc.on('close', function(code) {
    debug(name + ' process close');
    var index = processes.indexOf(procInfo);
    if (index > -1) {
      processes.splice(index, 1);
    } else {
      debug('procInfo not found');
    }

    // add the exit code to the info.
    var procFinInfo = _.extend({
      code: code,
    }, procInfo);

    // if we got an error add it to the info
    if (lastProcError) {
      procFinInfo.error = lastProcError;
    }

    if (masterRpc) {
      masterRpc.call(
        'onProcessEnd',
        toPublicProcInfo(procFinInfo)
      ).fail(function(err) {
        debug('onProcessEnd call error: ' + err.message);
      });
    } else {
      debug(
        'can not send process end msg to master, disconnected?'
      );
    }

    if (opts.promise === 'execution') {
      if (lastProcError) {
        debug(
          name +
          ' process exited with error: ' +
          lastProcError.message
        );
        deferred.reject(lastProcError);
      } else if (code !== 0) {
        debug(name + ' process exited with code: ' + code);
        deferred.reject(new Error(
          name + ' process exited with code: ' + code
        ));
      } else {
        deferred.resolve(toPublicProcInfo(procFinInfo));
      }
    }
  });

  // if only the creation should be promised resolve now.
  if (opts.promise === 'creation') {
    deferred.resolve(toPublicProcInfo(procInfo));
  } else {
    // if the execution is promised the std streams can be send.
    if (opts.stdout) {
      debug('piping stdout of ' + name + ' to ' + opts.stdout);
      var stdoutStream = this.mux.createStream(opts.stdout);
      proc.stdout.pipe(stdoutStream);
      stdoutStream.on('error', function(err) {
        debug(name + ' stdout pipe error: ' + err.message);
        proc.stdout.unpipe(stdoutStream);
        proc.stdout.resume();
      });
    }

    if (opts.stderr) {
      debug('piping stderr of ' + name + ' to ' + opts.stderr);
      var stderrStream = this.mux.createStream(opts.stderr);
      proc.stderr.pipe(stderrStream);
      stderrStream.on('error', function(err) {
        debug(name + ' stderr pipe error: ' + err.message);
        proc.stderr.unpipe(stderrStream);
        proc.stderr.resume();
      });
    }

    // send a notification to inform the server the process hast started.
    // the master then sends the span info to the the ctrl clients.
    process.nextTick(function() {
      if (lastProcError) {
        debug(
          'do NOT notify master of creation of ' + name +
          ' because error happend during cration: ' +
          lastProcError.message
        );
      } else {
        debug('notify master of creation of ' + name);
        deferred.notify(toPublicProcInfo(procInfo));
      }
    });
  }

  return deferred.promise;
};

PMNode.prototype.kill = function(opts) {
  var deferred = Q.defer();
  opts = _.extend({
    signal: 'SIGTERM',
  }, opts);

  if (!opts.pid) {
    debug('illigal kill call: pid missing!');
    deferred.reject(new Error('pid is required'));
  } else {
    var procInfo = _.findWhere(this.processes, {
      pid: opts.pid
    });
    if (!procInfo) {
      debug('illigal kill call: pid not found');
      deferred.reject(new Error('pid not found'));
    } else {
      if (procInfo.protected) {
        debug('illigal kill call: process is protected');
        deferred.reject(new Error('process is protected'));
      } else {
        if (!procInfo._proc) {
          debug('illigal kill call: invalid procInfo object');
          deferred.reject(new Error(
            'invalid procInfo object (pm-node internal error)'
          ));
        } else {
          procInfo._proc.kill(opts.signal);
          deferred.resolve(toPublicProcInfo(procInfo));
        }
      }
    }
  }

  return deferred.promise;
};
