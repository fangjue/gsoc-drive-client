/**
 * @fileoverview This file contains code to manage local files.
 */

'use strict';

var LocalEntry = function(localFileManager, path, fileEntry) {
  this.localFileManager_ = localFileManager;
  if (path && fileEntry) {
    this.path = path;
    this.fileEntry = fileEntry;
  }
};

LocalEntry.prototype.toStorage = function() {
  var value = {};
  if (this.remoteId)
    value.remoteId = this.remoteId;
  if (this.size)
    value.size = this.size;
  if (this.modifiedTime)
    value.modifiedTime = this.modifiedTime.getTime();
  if (this.remoteModifiedTime)
    value.remoteModifiedTime = this.remoteModifiedTime.getTime();
  if (this.md5)
    value.md5 = this.md5;

  return value;
};

LocalEntry.fromStorage = function(localFileManager, path, value) {
  var result = new LocalEntry(localFileManager);
  result.path = path;
  if (value.remoteId)
    result.remoteId = value.remoteId;
  if (value.size)
    result.size = value.size;
  if (value.modifiedTime)
    result.modifiedTime = new Date(value.modifiedTime);
  if (value.remoteModifiedTime)
    result.remoteModifiedTime = new Date(value.remoteModifiedTime);
  if (value.md5)
    result.md5 = value.md5;
  return result;
};

LocalEntry.readAsBlob = function(callback) {
  if (this.fileEntry) {
    this.fileEntry(callback, function(error) {
      callback(null, this.localFileManager_.fromFileError_(error));
    }.bind(this));
  } else
    callback(null, {}); // TODO: ??
};

LocalEntry.prototype.write = function(blob, callback) {
  if (this.fileEntry) {
    if (this.writer_) {
      this.writer_.onwrite = function() {
        this.fileEntry.getMetadata(function(metadata) {
          this.size = metadata.size;
          this.modifiedTime = metadata.modificationTime;
          this.update(callback);
        }.bind(this), function(error) {
          // TODO: Whether it's a fatal error?
          callback();
        });
      };
      this.writer_.onerror = function() {
        callback(this.localFileManager_.fromFileError_(this.writer_.error));
      }.bind(this);
      this.writer_.write(blob);
    } else {
      this.fileEntry.createWriter(function(writer) {
        this.writer_ = writer;
        this.writer_.onwrite = function() {
          this.write(blob, callback);
        };
        this.writer_.onerror = function() {
          callback(this.localFileManager_.fromFileError_(this.writer_.error));
        };
        this.writer_.truncate(0);
      }.bind(this), function(error) {
        callback(this.localFileManager_.fromFileError_(error));
      }.bind(this));
    }
  } else
    callback({}); // TODO: ??
};

LocalEntry.prototype.update = function(callback) {
  // TODO
};

var LocalFileManager = function(localRootEntry) {
  this.root_ = localRootEntry;
  this.rootEntry_ = new LocalEntry(this, '/', localRootEntry);
  return this;
};

LocalFileManager.prototype.load = function(callback) {
  console.assert(!this.loaded_);
  var items = {};
  items[storageKeys.local.files] = [];
  storageGetItem('local', items, function(paths) {
    this.paths = paths;
    chrome.storage.local.get(paths.map(function(path) {
      return storageKeys.local.entryPrefix + path;
    }.bind(this)), function(pathEntryMap) {
      this.pathEntryMap = dictMap(pathEntryMap,
          function(path, entry) {
        var realPath = strStripStart(path, storageKeys.local.entryPrefix);
        return [realPath, LocalEntry.fromStorage(this, realPath, entry)];
      }.bind(this));
      this.loaded_ = true;
      if (callback)
        callback();
    }.bind(this));
  }.bind(this));
};

// TODO: Figure out whether we really need this.
/*
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
    if (pathEntryMap[path].isDirectory)
      this.findChildren(pathEntryMap, pathChildrenMap, path + '/');
  }.bind(this));
  this.pathChildrenMap = pathChildrenMap;
  return pathChildrenMap;
};
*/

LocalFileManager.prototype.update = function(opt_callback, options) {
  var items = dictMap(this.pathEntryMap, function(path, entry) {
    return [storageKeys.local.entryPrefix + path, entry.toStorage()];
  }.bind(this));
  items[storageKeys.local.files] = Object.keys(this.pathEntryMap);
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
 * @param {function} callback
 * @param {DirectoryEntry} base_
 * @param {Object} pathEntryMap_
 * @param {Array.Object} errors_
 */
LocalFileManager.prototype.scan_ = function(callback, base_, pathEntryMap_,
    errors_) {
  var pathEntryMap = pathEntryMap_ || {};
  var errors = errors_ || [];
  if (!base_)
    base_ = this.root_;
  base_.createReader().readEntries(function(entries) {
    // TODO: Benchmark with asyncEvery and asyncForEach and find out which one
    // is better.
    asyncEvery1(entries, function(entry, callback) {
      var path = this.getEntryPath_(entry);
      var localEntry = new LocalEntry(this, path, entry);
      pathEntryMap[path] = localEntry;
      entry.getMetadata(function(metadata) {
        if (entry.isDirectory)
          this.scan_(callback, entry, pathEntryMap);
        else {
          localEntry.size = metadata.size;
          localEntry.modifiedTime = metadata.modificationTime;
          callback(pathEntryMap);
        }
      }.bind(this), function(error) {
        var error = this.fromFileError_(err);
        error.fileError.path = path;
        error.fileError.getMetadata = true;
        errors.push(error);
        callback(pathEntryMap, errors);
      });
    }.bind(this), function() {
      if (errors.length)
        callback(pathEntryMap, errors);
      else
        callback(pathEntryMap);
    });
  }.bind(this), function(err) {
    var error = this.fromFileError_(err);
    error.fileError.path = this.getEntryPath_(base_);
    error.fileError.readEntries = true;
    errors.push(error);
    callback(pathEntryMap, errors);
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
LocalFileManager.prototype.compare_ = function(pathEntryMap) {
  var currentPaths = Set.fromArray(Object.keys(pathEntryMap));
  var knownPaths = Set.fromArray(Object.keys(this.pathEntryMap));
  var createdPaths = currentPaths.minus(knownPaths);
  var deletedPaths = knownPaths.minus(currentPaths);
  var commonPaths = currentPaths.intersect(knownPaths);
  var modifiedPaths = new Set();

  commonPaths.forEach(function(path) {
    var currentEntry = pathEntryMap[path];
    var knownEntry = this.pathEntryMap[path];
    if (currentEntry.size != undefined) {
      if (currentEntry.size != knownEntry.size ||
          currentEntry.modifiedTime.getTime() !=
              knownEntry.modifiedTime.getTime())
      modifiedPaths.add(path);
    }
  }.bind(this));

  // TODO: Try to find out moved files.
  return {
    createdPaths: createdPaths,
    modifiedPaths: modifiedPaths,
    deletedPaths: deletedPaths
  };
};

// TODO: Persist pending changes after we can monitor folders.
LocalFileManager.prototype.getPendingChanges = function(callback) {
  console.assert(this.loaded_);
  this.scan_(function(pathEntryMap, error) {
    if (error)
      callback(null, error);
    else {
      this.newPathEntryMap = pathEntryMap;
      var changes = this.compare_(pathEntryMap);
      callback(changes);
    }
  }.bind(this));
};

LocalFileManager.prototype.getKnownEntryByPath = function(path) {
  console.assert(path.length > 0);
  if (path == '/')
    return this.rootEntry_;
  return this.pathEntryMap[path];
};

LocalFileManager.prototype.getCurrentEntryByPath = function(path) {
  console.assert(path.length > 0);
  if (path == '/')
    return this.rootEntry_;
  return this.newPathEntryMap[path];
};

/**
 * @typedef {Object} CreateEntryOptions
 * @property {boolean} isDirectory If the entry should be a directory.
 * @property {string} remoteId Remote entry id associated with this local entry.
 */

/**
 * @callback CreateEntryCallback
 * @param {LocalEntry} entry The created local entry.
 * @param {object} error
 */

/**
 * Create a new local entry.
 * @param {string} parentPath Full path of the parent.
 * @param {string} title File name.
 * @param {boolean} isDirectory Whether the new entry is a directory entry.
 * @param {string} remoteId The remote file id associated with this entry.
 * @param {CreateEntryCallback} callback
 */

LocalFileManager.prototype.createEntry = function(parentPath, title,
    isDirectory, remoteId, callback) {
  var sequence = 1;
  var fullPath = this.getFullPath_(parentPath, title, isDirectory);
  while (this.pathEntryMap[fullPath]) {
    // Try other names
    fullPath = this.getFullPath_(parentPath, title, isDirectory, sequence);
    ++sequence;
  }

  this.getDomEntry_(fullPath, {create: true, exclusive: !isDirectory},
      isDirectory, function(fileEntry) {
    var entry = new LocalEntry(this, fullPath, fileEntry);
    this.pathEntryMap[fullPath] = entry;
    entry.remoteId = remoteId;
    this.update(function() {
      callback(entry);
    }, {paths: [fullPath]});
  }.bind(this), function(err) {
    var error = this.fromFileError_(err);
    // Chrome returns InvalidModificationError when the path already exists and
    // |exclusive| is set to true.
    // InvalidModificationError is also used as a generic error code though. See
    // src/webkit/common/fileapi/file_system_util.cc:
    // PlatformFileErrorToWebFileError.
    if (error.fileError.type == 'InvalidModificationError' ||
        error.fileError.type == 'PathExistsError') {
      // This indicates a conflict of creating.
      error.conflict = true;
    }
    callback(null, error);
  }.bind(this));
};

LocalFileManager.prototype.getFullPath_ = function(parentPath, title,
    isDirectory, opt_sequence) {
  if (parentPath == '/')
    parentPath = '';
  return parentPath + this.sanitizeFileName_(title) +
      (isDirectory ? '/' : '') +
      (opt_sequence ? ' (' + opt_sequence.toString() + ')' : '');
};

LocalFileManager.prototype.sanitizeFileName_ = function(name) {
  if (systemInfo.os == 'win') {
    // For more details, see
    // http://msdn.microsoft.com/en-us/library/windows/desktop/aa365247(v=vs.85).aspx.
    name = name.replace(/<>:"\/\\\|\?\*/g, '_');
    if (name.substr(-1) == '.')
      name = name.substr(0, name.length - 1);
    name = name.replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.[^.]+)?$/i,
        '$1_$2');
  }

  return strTrim(name.replace(/\/|[\x00-\x1f]|\x7f/g, '_'));
};

/**
 * Append two paths:
 * '' appending '<any path>' = '<any path>'
 * '<any path>' appending '' = '<any path>'
 * <any path1>[/] appending <any path2>[/] =
 *     <any path1 without trailing slash>/<any path2 without trailing slash>
 * @param {string} path1
 * @param {string} path2
 */
LocalFileManager.prototype.appendPath_ = function(path1, path2) {
  if (!path1)
    return path2;
  if (!path2)
    return path1;
  if (strEndsWith(path1, '/') && strStartsWith(path2, '/'))
    return path1 + path2.substr(1);
  if (!strEndsWith(path1, '/') && !strStartsWith(path2, '/'))
    return path1 + '/' + path2;
  return path1 + path2;
};

/**
 * Handy shim for getFile and getDirectory methods.
 * @param {string} name
 * @param {Object} options
 * @param {boolean} isDirectory Call |getDirectory| if true. Call |getFile|
 *     otherwise.
 * @param {function} successCallback
 * @param {function} opt_errorCallback
 */
LocalFileManager.prototype.getDomEntry_ = function(path, options, isDirectory,
    successCallback, opt_errorCallback) {
  if (isDirectory)
    this.root_.getDirectory(path, options, successCallback, opt_errorCallback);
  else
    this.root_.getFile(path, options, successCallback, opt_errorCallback);
};

LocalFileManager.prototype.getEntryPath_ = function(entry) {
  console.assert(strStartsWith(entry.fullPath, this.root_.fullPath));
  var path = strStripStart(entry.fullPath, this.root_.fullPath);
  if (path[0] == '/')
    path = path.substr(1);
  if (entry.isDirectory)
    path += '/';
  return path;
};

LocalFileManager.prototype.fromFileError_ = function(fileError) {
  // TODO: Map errors into human readable messages.
  return {fileError: {type: fileError.name || 'GenericFileError'}};
};
