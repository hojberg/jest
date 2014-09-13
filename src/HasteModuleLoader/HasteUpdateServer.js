'use strict';

var MapUpdateTask = require('node-haste/lib/MapUpdateTask');

var hasteUtils = require('./hasteUtils');
var net = require('net');
var os = require('os');
var sane = require('sane');
var path = require('path');
var q = require('q');
var _ = require('underscore');

var debug = process.env.DEBUG ? console.log : function(){};

var DEFAULT_PORT = 5622;

var STATES = {
  starting: 'starting',
  updating: 'updating',
  ready: 'ready'
};

function HasteUpdateServer(configs, options) {
  this._state = STATES.starting;
  this._options = options || {};
  this._options.port = this._options.port || DEFAULT_PORT;
  this._configs = configs;
  this._hasteToDataMap = new Map();
  this._rootToHasteMap = new Map();
  q.all([
    this._constructHasteInstances(),
    this._createServer(),
    this._watchDirectories()
  ]).done(function() {
    debug('done initializing');
    this._state = STATES.ready;
  }.bind(this));
}

HasteUpdateServer.prototype._constructHasteInstances = function() {
  var promise = q.all(
    this._configs.map(constructHasteAndUpdate.bind(null, this._options))
  );
  promise.then(function(hastesAndData) {
    hastesAndData.forEach(function(hasteAndData) {
      var haste = hasteAndData.haste;
      var hasteData = hasteAndData.hasteData;
      this._hasteToDataMap.set(haste, hasteData);
      hasteData.config.testPathDirs.forEach(function(testPathDir) {
        this._rootToHasteMap.set(testPathDir, haste);
      }, this);
    }, this);
  }.bind(this));
  return promise;
};

HasteUpdateServer.prototype._handler = function(socket) {
  debug('connection');
  socket.end(this._state);
};

HasteUpdateServer.prototype._createServer = function() {
  var deferred = q.defer();
  this._server = net.createServer()
    .listen(this._options.port, function() {
      debug('server listening');
      deferred.resolve();
    });
  this._server.on('error', deferred.reject);
  this._server.on('connection', this._handler.bind(this));
  return deferred.promise;
};

HasteUpdateServer.prototype._watchDirectories = function() {
  var deferred = q.defer();
  var numDirsToWatch = this._configs.reduce(function(acc, config) {
    return acc + config.testPathDirs.length;
  }, 0);
  var resolve = _.after(numDirsToWatch, deferred.resolve);

  this._watchers = this._configs.map(function(config) {
    return config.testPathDirs.map(function(testPathDir) {
      var watcher = sane(testPathDir);
      watcher.on('ready', resolve);
      watcher.on('error', deferred.reject);
      watcher.on('all', this._changeHandler.bind(this));
      return watcher;
    }, this);
  }, this);
  return deferred;
};

HasteUpdateServer.prototype._changeHandler = function(type, file, root, stat) {
  debug('File change event', type, file, root);

  // Haste deals with absolute paths.
  file = path.join(root, file);

  var haste = this._rootToHasteMap.get(root);
  var hasteData = this._hasteToDataMap.get(haste);
  var map = hasteData.map;
  var config = hasteData.config;

  if (file.match(hasteUtils.getHasteIgnoreRegex(config))) {
    debug('File ignored');
    return;
  }

  stat = require('fs').statSync(file);

  var index = null;

  // Transform to a pair of path,mtime which is accepted by the update task.
  var files = map.getAllResources().map(function(resource, i) {
    if (resource.path === file) {
      index = i;
    }
    return [resource.path, resource.mtime];
  });

  if (type !== 'add' && !index) {
    throw new Error('Expected file to exit: ' + file);
  }

  switch (type) {
    case 'delete':
      files.splice(index, 1);
      break;
    case 'add':
      files.push([file, stat.mtime.getTime()]);
      break;
    case 'change':
      debug('before', files[index]);
      files[index][1] = stat.mtime.getTime();
      debug('after', files[index]);
      break;
    default:
      debug('Unknown change type', type);
      return;
  }

  this._state = STATES.updating;

  var task = new MapUpdateTask(
    files,
    hasteUtils.buildLoadersList(config),
    map,
    {
      maxOpenFiles: this._options.maxOpenFiles || 100,
      maxProcesses: this._options.maxProcesses || os.cpus().length
    }
  );

  var ready = function() {
    this._state = STATES.ready;
    debug('update complete');
  }.bind(this);

  task.on('complete', function(map) {
    var mapChanged = task.changed.length > task.skipped.length;
    if (mapChanged) {
      hasteData.map = map;
      haste.storeMap(hasteUtils.getCacheFilePath(config), map, ready);
    } else {
      ready();
    }
  });

  debug('starting node-haste map update task');
  task.run();
};

function constructHasteAndUpdate(options, config) {
  var deferred = q.defer();
  try {
    var haste = hasteUtils.constructHasteInst(config, options);
    var hasteData = { config: config };

    haste.update(hasteUtils.getCacheFilePath(config), function(map) {
      hasteData.map = map;
      deferred.resolve({
        haste: haste,
        hasteData: hasteData
      });
    });
  } catch (e) {
    deferred.reject(e);
  }

  return deferred.promise;
}

module.exports = HasteUpdateServer;
