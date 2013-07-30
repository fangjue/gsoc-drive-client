/**
 * @fileoverview This file contains code to manage remote files on Google Drive.
 */

'use strict';

function RemoteEntry(metadata) {
  this.metadata = metadata;
  this.init_();
  return this;
};

RemoteEntry.fromStorage = function(entry) {
  var result = new RemoteEntry(entry.metadata);
  if (entry.localPaths)
    result.localPaths = entry.localPaths;
  if (entry.localTitle)
    result.localTitle = entry.localTitle;
  return result;
};

RemoteEntry.prototype.toStorage = function() {
  var result = {metadata: this.metadata};
  if (this.localPaths)
    result.localPaths = this.localPaths;
  if (this.localTitle)
    result.localTitle = this.localTitle;
  return result;
};

RemoteEntry.prototype.init_ = function() {
  this.isFolder = this.metadata.id == 'root' || this.metadata.mimeType ==
      'application/vnd.google-apps.folder';
};
// Can modify |metadata|.
RemoteEntry.prototype.updateMetadata = function(metadata) {
  this.metadata = metadata;
  this.init_();
};

var RemoteFileManager = function() {
  this.drive_ = new GoogleDrive({
    fields: {
      about: 'name,quotaBytesTotal,quotaBytesUsed,quotaBytesUsedAggregate,' + 
              'quotaBytesUsedInTrash,largestChangeId,user',
      files: 'id,etag,title,mimeType,modifiedDate,downloadUrl,md5Checksum,' + 
          'fileSize,parents(id,isRoot),labels(trashed)',
    },
  });
  /** @const */ this.STORAGE_LARGEST_CHANGE_ID = 'remote.largestChangeId';
  /** @const */ this.STORAGE_IDS = 'remote.ids';
  /** @const */ this.STORAGE_PENDING_CHANGES = 'remote.pendingChanges';
  /** @const */ this.STORAGE_ENTRY_PREFIX = 'remote.entry.';

  this.rootEntry_ = new RemoteEntry({id: 'root'});
};

RemoteFileManager.prototype.load = function(callback) {
  console.assert(!this.loaded_);
  var items = {};
  items[this.STORAGE_LARGEST_CHANGE_ID] = 0;
  items[this.STORAGE_IDS] = [];
  items[this.STORAGE_PENDING_CHANGES] = {};
  chrome.storage.local.get(items, function(items) {
    this.largestChangeId = items[this.STORAGE_LARGEST_CHANGE_ID];
    this.pendingChanges = items[this.STORAGE_PENDING_CHANGES];
    chrome.storage.local.get(items[this.STORAGE_IDS].map(function(id) {
      return this.STORAGE_ENTRY_PREFIX + id;
    }.bind(this)), function(idEntryMap) {
      this.idEntryMap = dictMap(idEntryMap, function(id, entry) {
        return [strStripStart(id, this.STORAGE_ENTRY_PREFIX),
                RemoteEntry.fromStorage(entry)];
      }.bind(this));
      this.loaded_ = true;
      callback();
    }.bind(this));
  }.bind(this));
};

RemoteFileManager.prototype.update = function(opt_callback, opt_items) {
  var items = {};
  if (!opt_items || opt_items.indexOf('entries') != -1) {
    items = dictMap(this.idEntryMap, function(id, entry) {
      return [this.STORAGE_ENTRY_PREFIX + id, entry.toStorage()];
    }.bind(this));
    items[this.STORAGE_IDS] = Object.keys(this.idEntryMap);
  }
  if ((!opt_items || opt_items.indexOf('largestChangeId') != -1) &&
      this.largestChangeId)
    items[this.STORAGE_LARGEST_CHANGE_ID] = this.largestChangeId;
  if (!opt_items || opt_items.indexOf('pendingChanges') != -1 &&
      Object.keys(this.pendingChanges).length > 0)
    items[this.STORAGE_PENDING_CHANGES] = this.pendingChanges;
  chrome.storage.local.set(items, opt_callback);
};

/*
RemoteFileManager.prototype.findChildren = function() {
  var excludedIds = [];
  this.idChildrenMap = {};
  dictForEach(this.idEntryMap, function(id, entry) {
    if (entry.metadata.parents) {
      if (entry.metadata.parents.length == 0)
        excludedIds.push(entry.metadata.id);

      entry.metadata.parents.forEach(function(parent) {
        var id = parent.isRoot ? 'root' : parent.id;
        if (this.idChildrenMap[id])
          this.idChildrenMap[id].push(entry);
        else
          this.idChildrenMap[id] = [entry];
      }.bind(this));
    }
  }.bind(this));

  // This removes folders without parents, such as Chrome Syncable Filesystem.
  excludedIds.forEach(this.removeEntries.bind(this));
};

RemoteFileManager.prototype.removeEntries = function(id) {
  (this.idChildrenMap[id] || []).forEach(this.removeEntries.bind(this));
  delete this.idChildrenMap[id];
  delete this.idEntryMap[id];
};*/

/**
 * Scan remote files inside My Drive.
 * @param {function} callback Called with the result.
 */
RemoteFileManager.prototype.scan_ = function(callback) {
  this.drive_.getAccountInfo({fields: 'largestChangeId'},
      function(info, error) {
    if (!info) {
      callback(error);
      return;
    }

    this.largestChangeId = info.largestChangeId;

    this.drive_.getAll({q: '\'me\' in owners and trashed = false'},
        function(files, error) {
      if (error) {
        callback(error);
        return;
      }

      this.idEntryMap = {};
      files.forEach(function(entry) {
        this.pendingChanges[entry.id] = entry;
      }.bind(this));

      callback();
    }.bind(this));
  }.bind(this));
};

RemoteFileManager.prototype.fetchChanges_ = function(callback) {
  this.drive_.getChanges({startChangeId: parseInt(this.largestChangeId) + 1,
      includeSubscribed: false}, function(changes, error) {
    if (changes) {
      this.largestChangeId = changes.largestChangeId;
      callback(changes.items);
    } else
      callback(null, error);
  }.bind(this));
};

RemoteFileManager.prototype.getChanges_ = function(callback) {
  console.assert(this.largestChangeId);
  this.fetchChanges_(function(changes, error) {
    if (error)
      callback(error)
    else {
      changes.forEach(function(change) {
        if (change.deleted)
          this.pendingChanges[change.fileId] = {};
        else
          this.pendingChanges[change.fileId] = change.file;
      }.bind(this));
      callback();
    }
  }.bind(this));
};

RemoteFileManager.prototype.getPendingChanges = function(callback) {
  var onResult = function (error) {
    if (error)
      callback(null, error);
    else {
      var result = this.parseChanges_();
      this.update(function(error) {
        if (error)
          callback(null, error);
        else
          callback(result);
      }, ['pendingChanges', 'largestChangeId']);
    }
  }.bind(this);

  if (this.largestChangeId)
    this.getChanges_(onResult);
  else
    this.scan_(onResult);
};

RemoteFileManager.prototype.parseChanges_ = function() {
  var result = [];
  var excludedIds = [];
  Object.keys(this.pendingChanges).forEach(function(id) {
    var entry = this.pendingChanges[id];
    if (this.isFileManaged_(id)) {
      if (this.idEntryMap[id]) {
        var oldEntry = this.idEntryMap[id];
        var change = {file: entry, id: id};
        if (Object.keys(entry).length == 0)
          change.deleted = true;
        if (oldEntry.fileSize != entry.fileSize ||
            oldEntry.md5Checksum != entry.md5Checksum)
          change.modified = true;
        if (oldEntry.title != entry.title) {
          change.renamedFrom = oldEntry.title;
          change.renamedTo = entry.title;
        }
        this.parseParentsChange_(oldEntry, entry, change);
        result.push(change);
      } else
        result.push({created: true, file: entry});
    } else if (Object.keys(entry).length != 0)
      excludedIds.push(id);
  }.bind(this));
  excludedIds.forEach(function(id) {
    delete this.pendingChanges[id];
  }.bind(this));
  return result;
};

RemoteFileManager.prototype.isFileManaged_ = function(id) {
  if (id == 'root')
    return true;
  var entry = this.pendingChanges[id] || this.idEntryMap[id];
  if (!entry || Object.keys(entry).length == 0)
    return false;

  return entry.parents.some(function(parent) {
    return parent.isRoot || this.isFileManaged_(parent.id);
  }.bind(this));
};

RemoteFileManager.prototype.parseParentsChange_ = function(oldEntry, newEntry, change) {
  var oldParents = Set.fromArray(oldEntry.parents.transform(this.getParentId_));
  var newParents = Set.fromArray(newEntry.parents.transform(this.getParentId_));
  change.movedFrom = oldParents.minus(newParents);
  change.movedTo = newParents.minus(oldParents);
};

RemoteFileManager.prototype.getParentId_ = function(parent) {
  return parent.isRoot ? 'root' : parent.id;
};

/**
 * Find out the full paths of a file. A file can have multiple parents and each
 * of them can also have multiple parents. As a result, a file can have multiple
 * paths.
 * @param {string} id The id of the file.
 * @param {function} opt_operationCallback An asynchronous operation to perform
 *     on parent folders found. It should specify a function like this:
 *     function(id, callback) {...}
 *     and |callback| should be called like this:
 *     callback(error);
 *     when the operation is completed, where |error| indicates error
 *     information, if any.
 * @param {function} pathCallback Called when all the paths are found. It should
 *     specify a function like this:
 *     function(paths, error) {...}
 *     where |paths| is an array of arrays containing each path component's id.
 */
RemoteFileManager.prototype.findPaths = function(id, opt_operationCallback, pathCallback, errors_) {
  if (!opt_operationCallback)
    opt_operationCallback = function(id, callback) {callback()};
  var paths = [];
  if (!errors_)
    errors_ = [];

  if (!this.isFileManaged_(id)) {
    console.warn('Unmanaged file id passed to RemoteFileManager.findPaths', id);
    pathCallback([]);
  } else if (id == 'root') {
    opt_operationCallback('root', function(error) {
      if (error)
        pathCallback([], error);
      else
        pathCallback([['root']]);
    });
  } else {
    var entry = this.pendingChanges[id] || this.idEntryMap[id];
    var parentIds = entry.parents.map(function(parent) {
      return this.getParentId_(parent);
    }.bind(this));

    asyncEvery1([function(done) {
      // Step 1: Perform |opt_operationCallback| on each parent.
      asyncEvery1(parentIds, opt_operationCallback, function(errors) {
        // Step 1 completed.
        errors.forEach(function(error) {
          if (error)
            errors_.push(error);
        });
        done();
      });
    }, function(done) {
      // Step 2: Find each parent's paths.
      asyncEvery1(parentIds, function(id, callback) {
        this.findPaths(id, opt_operationCallback, callback, errors_);
      }.bind(this), function(results) {
        // Step 2 completed.
        results.forEach(function(parentPaths) {
          parentPaths.forEach(function(parentPath) {
            paths.push(parentPath.concat(id));
          });
        });
        done();
      });
    }.bind(this)], function(func, callback) {
      func(callback);
    }, function() {
      pathCallback(paths, errors_.length > 0 ? errors_ : undefined);
    });

    // TODO: The two steps should be initiated independently and the final
    // callback is called when both of them are completed.
  }
};

RemoteFileManager.prototype.getEntry = function(id) {
  return this.idEntryMap[id];
};

RemoteFileManager.prototype.getRoot = function() {
  return this.rootEntry_;
};
