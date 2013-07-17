/**
 * @fileoverview This file contains code to manage local files.
 */

'use strict';

var LocalEntry = function(path, fileEntry) {
  if (path && fileEntry) {
    this.path = path;
    this.fileEntry = fileEntry;
  }
};

LocalEntry.prototype.toStorage = function() {
  var result = {};
  dictForEach(this.metadata, function(key, value) {
    result[key] = value;
  });

  if (result.modifiedTime)
    result.modifiedTime = result.modifiedTime.getTime();
  return result;
};

LocalEntry.fromStorage = function(path, metadata) {
  var result = new LocalEntry();
  result.path = path;
  // TODO: Do we need a deep copy here?
  result.metadata = metadata;
  if (metadata.modifiedTime)
    result.metadata.modifiedTime = new Date(result.metadata.modifiedTime);
  return result;
};

var LocalFileManager = function() {
  /** @const */ this.STORAGE_FILES = 'local.files';
  /** @const */ this.STORAGE_ENTRY_PREFIX = 'local.entry.';
  return this;
};

LocalFileManager.prototype.load = function(callback) {
  var items = {};
  items[this.STORAGE_FILES] = [];
  storageGetItem('local', items, function(paths) {
    this.paths = paths;
    chrome.storage.local.get(paths.map(function(path) {
      return this.STORAGE_ENTRY_PREFIX + path;
    }.bind(this)), function(pathEntryMap) {
      this.pathEntryMap = dictMap(pathEntryMap,
          function(path, entry) {
        var realPath = strStripStart(path, this.STORAGE_ENTRY_PREFIX);
        return [realPath, LocalEntry.fromStorage(realPath, entry)];
      }.bind(this));
      this.pathChildrenMap = this.findChildren(this.pathEntryMap);
      callback(this.pathEntryMap);
    }.bind(this));
  }.bind(this));
};

LocalFileManager.prototype.findChildren = function(pathEntryMap,
    pathChildrenMap_, base_) {
  var paths = Object.keys(pathEntryMap);
  var pathChildrenMap = pathChildrenMap_ || {};
  var base = base_ || '';
  paths.filter(function(path) {
    return strStartsWith(path, base) &&
        strStripStart(path, base).indexOf('/') == -1;
  }).forEach(function(path) {
    if (pathChildrenMap[base])
      pathChildrenMap[base].push(path);
    else
      pathChildrenMap[base] = [path];
    if (pathEntryMap[path].metadata.isDirectory)
      this.findChildren(pathEntryMap, pathChildrenMap, path + '/');
  }.bind(this));
  this.pathChildrenMap = pathChildrenMap;
  return pathChildrenMap;
};

LocalFileManager.prototype.update = function(opt_callback) {
  var items = dictMap(this.pathEntryMap, function(path, entry) {
    return [this.STORAGE_ENTRY_PREFIX + path, entry.toStorage()];
  }.bind(this));
  items[this.STORAGE_FILES] = Object.keys(this.pathEntryMap);
  chrome.storage.local.set(items, opt_callback);
};

LocalFileManager.prototype.stripBasePath_ = function(fullPath, basePath) {
  basePath += '/';
  if (fullPath.substr(0, basePath.length) == basePath)
    return fullPath.substr(basePath.length);
  else
    console.warn('stripBasePath_: ' + fullPath + ', ' + basePath);
};

/**
 * Scan local files in the sync folder.
 * @param {DirectoryEntry} root
 * @param {function} callback
 * @param {object} pathEntryMap_
 * @param {DirectoryEntry} base_
 */
LocalFileManager.prototype.scan = function(root, callback,
    pathEntryMap_, base_) {
  var pathEntryMap = pathEntryMap_ || {};
  if (!base_)
    base_ = root;
  base_.createReader().readEntries(function(entries) {
    asyncForEach1(entries, function(entry, callback) {
      console.assert(strStartsWith(entry.fullPath, root.fullPath + '/'));
      var path = strStripStart(entry.fullPath, root.fullPath + '/');
      var localEntry = new LocalEntry(path, entry);
      pathEntryMap[path] = localEntry;
      entry.getMetadata(function(metadata) {
        localEntry.metadata = {
          size: metadata.size,
          modifiedTime: metadata.modificationTime,
        };
        if (entry.isDirectory)
          localEntry.metadata.isDirectory = true;

        if (entry.isDirectory)
          this.scan(root, callback, pathEntryMap, entry);
        else
          callback();
      }.bind(this), function(error) {
        localEntry.error = error;
        localEntry.metadata = {};
        callback();
      });
    }.bind(this), function() {
      callback(pathEntryMap);
    });
  }.bind(this));
};

/**
 * Compare local files scanned and entries loaded from storage. Find out
 * created, modified and deleted paths respectively.
 * @param {object} pathEntryMap Contains all files scanned, along with their
 *     metadata.
 * @returns {object} An object with createdPaths, modifiedPaths and
 * deletedPaths properties.
 */
LocalFileManager.prototype.compare = function(pathEntryMap) {
  var currentPaths = Set.fromArray(Object.keys(pathEntryMap));
  var knownPaths = Set.fromArray(Object.keys(this.pathEntryMap));
  var createdPaths = currentPaths.minus(knownPaths);
  var deletedPaths = knownPaths.minus(currentPaths);
  var commonPaths = currentPaths.intersect(knownPaths);
  var modifiedPaths = new Set();

  commonPaths.forEach(function(path) {
    var currentEntry = pathEntryMap[path];
    var knownEntry = this.pathEntryMap[path];
    console.assert(currentEntry.metadata && knownEntry.metadata);
    if (currentEntry.metadata.size != undefined) {
      if (currentEntry.metadata.size != knownEntry.metadata.size ||
          currentEntry.metadata.modifiedTime.getTime() !=
              knownEntry.metadata.modifiedTime.getTime())
      modifiedPaths.add(path);
    }
  }.bind(this));

  return {
    createdPaths: createdPaths,
    modifiedPaths: modifiedPaths,
    deletedPaths: deletedPaths
  };
};
