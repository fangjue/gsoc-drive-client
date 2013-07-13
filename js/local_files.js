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
  result.metadata = new Date(metadata);
};

var LocalFiles = {};

LocalFiles.load = function(callback) {
  storageGetItem('local', {'local.files': []}, function(paths) {
    LocalFiles.paths = paths;
    chrome.storage.local.get(paths, function(pathEntryMap) {
      LocalFiles.pathEntryMap = dictMapValue(pathEntryMap,
          function(path, entry) {
        return LocalEntry.fromStorage(path, entry);
      });
      callback(LocalFiles.pathEntryMap);
    });
  });
};

LocalFiles.update = function(opt_callback) {
  chrome.storage.local.set(dictMapValue(LocalFiles.pathEntryMap,
      function(path, entry) {
    return entry.toStorage();
  }), opt_callback);
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
    if (currentEntry.size != undefined &&
        (currentEntry.size != knownEntry.size ||
         currentEntry.modifiedTime != knownEntry.modifiedTime))
      modifiedPaths.add(path);
  });

  return {
    createdPaths: createdPaths,
    modifiedPaths: modifiedPaths,
    deletedPaths: deletedPaths
  };
};
