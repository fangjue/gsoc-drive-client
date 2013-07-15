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

var LocalFiles = {
  STORAGE_FILES: 'local.files',
  STORAGE_ENTRY_PREFIX: 'local.entry.',
};

LocalFiles.load = function(callback) {
  var items = {};
  items[LocalFiles.STORAGE_FILES] = [];
  storageGetItem('local', items, function(paths) {
    LocalFiles.paths = paths;
    chrome.storage.local.get(paths.map(function(path) {
      return LocalFiles.STORAGE_ENTRY_PREFIX + path;
    }), function(pathEntryMap) {
      LocalFiles.pathEntryMap = dictMap(pathEntryMap,
          function(path, entry) {
        var realPath = strStripStart(path, LocalFiles.STORAGE_ENTRY_PREFIX);
        return [realPath, LocalEntry.fromStorage(realPath, entry)];
      });
      callback(LocalFiles.pathEntryMap);
    });
  });
};

LocalFiles.update = function(opt_callback) {
  var items = dictMap(LocalFiles.pathEntryMap, function(path, entry) {
    return [LocalFiles.STORAGE_ENTRY_PREFIX + path, entry.toStorage()];
  });
  items[LocalFiles.STORAGE_FILES] = Object.keys(LocalFiles.pathEntryMap);
  chrome.storage.local.set(items, opt_callback);
};

LocalFiles.stripBasePath_ = function(fullPath, basePath) {
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
LocalFiles.scan = function(root, callback, pathEntryMap_, base_) {
  var pathEntryMap = pathEntryMap_ || {};
  if (!base_)
    base_ = root;
  base_.createReader().readEntries(function(entries) {
    asyncForEach1(entries, function(entry, callback) {
      var path = LocalFiles.stripBasePath_(entry.fullPath, root.fullPath);
      var localEntry = new LocalEntry(path, entry);
      pathEntryMap[path] = localEntry;
      entry.getMetadata(function(metadata) {
        localEntry.metadata = {
          size: metadata.size,
          modifiedTime: metadata.modificationTime,
        };

        if (entry.isDirectory)
          LocalFiles.scan(root, callback, pathEntryMap, entry);
        else
          callback();
      }, function(error) {
        localEntry.error = error;
        localEntry.metadata = {};
        callback();
      });
    }, function() {
      callback(pathEntryMap);
    });
  });
};

/**
 * Compare local files scanned and entries loaded from storage. Find out
 * created, modified and deleted paths respectively.
 * @param {object} pathEntryMap Contains all files scanned, along with their
 *     metadata.
 * @returns {object} An object with createdPaths, modifiedPaths and
 * deletedPaths properties.
 */
LocalFiles.compare = function(pathEntryMap) {
  var currentPaths = Set.fromArray(Object.keys(pathEntryMap));
  var knownPaths = Set.fromArray(Object.keys(LocalFiles.pathEntryMap));
  var createdPaths = currentPaths.minus(knownPaths);
  var deletedPaths = knownPaths.minus(currentPaths);
  var commonPaths = currentPaths.intersect(knownPaths);
  var modifiedPaths = new Set();

  commonPaths.forEach(function(path) {
    var currentEntry = pathEntryMap[path];
    var knownEntry = LocalFiles.pathEntryMap[path];
    console.assert(currentEntry.metadata && knownEntry.metadata);
    if (currentEntry.metadata.size != undefined) {
      if (currentEntry.metadata.size != knownEntry.metadata.size ||
          currentEntry.metadata.modifiedTime.getTime() !=
              knownEntry.metadata.modifiedTime.getTime())
      modifiedPaths.add(path);
    }
  });

  return {
    createdPaths: createdPaths,
    modifiedPaths: modifiedPaths,
    deletedPaths: deletedPaths
  };
};
