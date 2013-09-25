/**
 * @fileoverview This file contains code to manage remote files on Google Drive.
 */

'use strict';

function RemoteEntry(metadata) {
  this.init_(metadata);
  return this;
};

RemoteEntry.COPY_FIELDS = [
  'id', 'etag', 'title', 'fileSize', 'headRevisionId', 'md5Checksum',
  'localTitle'
];

RemoteEntry.prototype.toStorage = function() {
  var result = {};
  RemoteEntry.COPY_FIELDS.forEach(function(field) {
    if (this[field] != undefined)
      result[field] = this[field];
  }.bind(this));

  if (this.modifiedDate)
    result.modifiedDate = this.modifiedDate.getTime();
  if (this.parents)
    result.parents = this.parents.concat();

  return result;
};

RemoteEntry.prototype.init_ = function(metadata) {
  RemoteEntry.COPY_FIELDS.forEach(function(field) {
    if (metadata[field] != undefined)
      this[field] = metadata[field];
  }.bind(this));

  if (metadata.modifiedDate) 
    this.modifiedDate = new Date(metadata.modifiedDate);
  if (metadata.parents) {
    this.parents = metadata.parents.map(function(parent) {
      if (parent.isRoot)
        return 'root';
      return parent.id;
    });
  }
  this.isFolder = metadata.id == 'root' ||
      metadata.mimeType == GoogleDrive.MIME_TYPE_FOLDER;

  if (this.id == 'root')
    this.localTitle = '';
};

RemoteEntry.prototype.updateMetadata = function(metadata) {
  // TODO: Partial or complete update?
  this.init_(metadata);
};

var RemoteFileManager = function() {
  this.drive_ = new GoogleDrive({
    fields: {
      about: 'name,quotaBytesTotal,quotaBytesUsed,quotaBytesUsedAggregate,' + 
             'quotaBytesUsedInTrash,largestChangeId,user',
      files: 'id,etag,title,mimeType,modifiedDate,md5Checksum,fileSize,' +
             'parents(id,isRoot),labels(trashed),headRevisionId',
    },
  });

  this.rootEntry_ = new RemoteEntry({id: 'root', parents: []});
  this.idsToPurge = [];
};

RemoteFileManager.prototype.load = function(callback) {
  console.assert(!this.loaded_);
  var items = {};
  items[storageKeys.remote.largestChangeId] = 0;
  items[storageKeys.remote.ids] = [];
  items[storageKeys.remote.pendingChanges] = {};
  chrome.storage.local.get(items, function(items) {
    this.largestChangeId = items[storageKeys.remote.largestChangeId];
    this.pendingChanges = items[storageKeys.remote.pendingChanges];
    chrome.storage.local.get(items[storageKeys.remote.ids].map(function(id) {
      return storageKeys.remote.entryPrefix + id;
    }.bind(this)), function(idEntryMap) {
      this.idEntryMap = dictMap(idEntryMap, function(id, entry) {
        return [strStripStart(id, storageKeys.remote.entryPrefix),
                new RemoteEntry(entry)];
      }.bind(this));
      this.loaded_ = true;
      if (callback)
        callback();
    }.bind(this));
  }.bind(this));
};

RemoteFileManager.prototype.update = function(opt_callback, opt_items) {
  var items = {};
  if (!opt_items || opt_items.indexOf('entries') != -1 ||
      opt_items.indexOf('removeEntry') != -1) {
    if (opt_items && opt_items.indexOf('entries') != -1) {
      items = dictMap(this.idEntryMap, function(id, entry) {
        return [storageKeys.remote.entryPrefix + id, entry.toStorage()];
      }.bind(this));
    }
    items[strorageKeys.remote.ids] = Object.keys(this.idEntryMap);
  }
  if ((!opt_items || opt_items.indexOf('largestChangeId') != -1) &&
      this.largestChangeId)
    items[storageKeys.remote.largestChangeId] = this.largestChangeId;
  if (!opt_items || opt_items.indexOf('pendingChanges') != -1 &&
      Object.keys(this.pendingChanges).length > 0)
    items[storageKeys.remote.pendingChanges] = this.pendingChanges;
  chrome.storage.local.set(items, opt_callback);
};

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
      this.pendingChanges = {};
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
  var result = {};
  for (var id in this.pendingChanges) {
    var change = this.parsePendingChange_(id);
    if (change)
      result[id] = change;
  }
  return result
};

/**
 * Returns true if the entry is not in My Drive (this includes subscribed
 * entries and entries in the Chrome Syncable Filesystem folder.
 * @param {string} id The file's id.
 * @returns {boolean} Whether the file is in My Drive.
 */
RemoteFileManager.prototype.isFileManaged_ = function(id) {
  if (id == 'root')
    return true;
  var newEntry = this.pendingChanges[id];
  var knownEntry = this.idEntryMap[id];
  if (!newEntry && !knownEntry)
    return false;

  var dummy = {parents: []};
  if (Object.keys(newEntry).length == 0)
    newEntry = dummy;
  // TODO: Optimize this.
  // TODO: Or integrate this into findPaths?
  return (newEntry || dummy).parents.concat((knownEntry || dummy).parents).
      some(function(parent) {
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

RemoteFileManager.prototype.hasPendingChange = function(id) {
  return this.pendingChanges[id] != undefined;
};

RemoteFileManager.prototype.parsePendingChange_ = function(id) {
  if (!this.isFileManaged_(id)) {
    delete this.pendingChanges[id];
    return null;
  }

  var pendingChange = this.pendingChanges[id];
  var knownEntry = this.idEntryMap[id];
  if (knownEntry) {
    if (knownEntry.etag && knownEntry.etag == pendingChange.etag) {
      // The change is probably made by this app itself.
      if (!knownEntry.headRevisionId && pendingChange.headRevisionId)
        // The response of an upload request does not contain
        // headRevisionId. See also
        // http://stackoverflow.com/questions/18182453/when-inserting-a-new-file-in-google-drive-sdk-there-is-no-headrevisionid-in-the
        knownEntry.headRevisionId = pendingChange.headRevisionId;
      // We already made the change.
      delete this.pendingChanges[id];
      return;
    }

    var change = {id: id};
    if (Object.keys(pendingChange).length == 0) {
      // Empty dictionary indicates deletion.
      change.deleted = true;
    } else if (pendingChange.labels && pendingChange.labels.trashed) {
      change.deleted = true;
    } else {
      if (knownEntry.fileSize != pendingChange.fileSize ||
          knownEntry.md5Checksum != pendingChange.md5Checksum ||
          knownEntry.headRevisionId != pendingChange.headRevisionId)
        change.modified = true;
      if (knownEntry.title != pendingChange.title) {
        change.renamedFrom = knownEntry.title;
        change.renamedTo = pendingChange.title;
      }
      var newEntry = new RemoteEntry(pendingChange);
      change.newEntry = newEntry;
      this.parseParentsChange_(knownEntry, newEntry, change);
    }
    return change;
  } else
    return {created: true, newEntry: new RemoteEntry(pendingChange)};
};

RemoteFileManager.prototype.addEntry = function(metadata) {
  return this.idEntryMap[metadata.id] = new RemoteEntry(metadata);
};

RemoteFileManager.prototype.createFile = function(name, blob, details,
    callback) {
  this.drive_.upload({
    title: name,
    modifiedDate: details.modifiedTime.toUTCString(),
    parents: [{id: details.parentId}]
  }, blob, {}, function(metadata, error) {
    if (error)
      callback(null, error);
    else
      callback(this.addEntry(metadata));
  }.bind(this));
};

RemoteFileManager.prototype.createDirectory = function(name, parentId,
    callback) {
  this.drive_.createFolder(parentId, name, {}, function(metadata, error) {
    if (error)
      callback(null, error);
    else
      callback(this.addEntry(metadata));
  });
};

RemoteFileManager.prototype.removeEntry = function(id, callback) {
  if (this.deletePermanently)
    this.drive_.remove(id, function(error) {
      if (!error)
        this.removeEntryFromStorage_(id, callback);
    }.bind(this));
  else
    this.drive_.trash(id, {}, function(metadata, error) {
      if (!error)
        this.removeEntryFromStorage_(id, callback);
    }.bind(this));
};

RemoteFileManager.prototype.removeEntryFromStorage_ = function(id, callback) {
  delete this.idEntryMap[id];
  this.idsToPurge.push(id);
  this.update(callback, ['removeEntry']);
};

// After remote->local sync.
RemoteFileManager.prototype.resolvePendingChange = function(id, etag, newEntry,
    callback) {
  var pendingChange = this.pendingChanges[id];
  if (!pendingChange || pendingChange.etag != etag) {
    return;
  }
  this.idEntryMap[id] = newEntry;
  delete this.pendingChanges[id];
  this.update(callback, ['pendingChanges']);
};

/**
 * Unexpected changes, such as creating a file in a deleted folder, are
 * directly removed from pendingChanges by calling this method.
 * @param {string} id
 */
RemoteFileManager.prototype.ignorePendingChange = function(id, callback) {
  delete this.pendingChanges[id];
  this.update(callback, ['pendingChanges']);
};

/**
 * Find out the full paths of a file. A file can have multiple parents and each
 * of them can also have multiple parents. As a result, a file can have multiple
 * paths.
 * NOTE: If there are entries that have pending moves, these moves are ignored.
 * @param {string} id The id of the file.
 * @returns {Array.Array.string} All paths for the file, represented as an
 * array of arrays containing each path component's id.
 */
RemoteFileManager.prototype.findPaths = function(id) {
  var paths = [];

  if (id == 'root')
    return [['root']];

  var entry = this.idEntryMap[id];
  if (!entry) {
    var pendingChange = this.pendingChanges[id];
    if (!pendingChange)
      return paths;
    if (Object.keys(pendingChange).length == 0)
      return paths;
    // TODO: pendingChanges[id] should be a RemoteEntry?
    entry = new RemoteEntry(pendingChange);
  }

  entry.parents.forEach(function(parentId) {
    var parentPaths = this.findPaths(parentId);
    parentPaths.forEach(function(parentPath) {
      paths.push(parentPath.concat(id));
    });
  }.bind(this));

  return paths;
};

RemoteFileManager.prototype.getEntry = function(id) {
  if (id == 'root')
    return this.rootEntry_;
  else
    return this.idEntryMap[id];
};
