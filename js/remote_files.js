/**
 * @fileoverview This file contains code to manage remote files on Google Drive.
 */

'use strict';

function RemoteEntry(metadata) {
  this.metadata = metadata;
  this.isFolder = metadata.id == 'root' || metadata.mimeType ==
      'application/vnd.google-apps.folder';
  return this;
};

RemoteEntry.fromStorage = function(entry) {
  var result = new RemoteEntry(entry.metadata);
  if (entry.localPath)
    result.localPath = entry.localPath;
  return result;
};

RemoteEntry.prototype.toStorage = function() {
  var result = {metadata: this.metadata};
  if (this.localPath)
    result.localPath = this.localPath;
  return result;
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
  items[this.STORAGE_PENDING_CHANGES] = [];
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
      this.findChildren();
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
      this.pendingChanges.length > 0)
    items[this.STORAGE_PENDING_CHANGES] = this.pendingChanges;
  chrome.storage.local.set(items, opt_callback);
};

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
      files.forEach(function(entry) {
        this.idEntryMap[entry.id] = new RemoteEntry(entry);
      }.bind(this));

      this.findChildren();

      this.update(callback);
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

// TODO: Detect changes that are already made (ie. between the first
// largestChangeId and the first scanning).
RemoteFileManager.prototype.parseChanges_ = function(changes) {
  var result = [];
  changes.forEach(function(change) {
    var id = change.fileId;
    var entry = this.idEntryMap[id];
    if (!entry) {
      // TODO: Some files are created in an excluded folder.
      result.push({type: 'create', id: id});
      // TODO: Update idChildrenMap.
      // For convenience, created files are added to idEntryMap.
      this.idEntryMap[id] = new RemoteEntry(change.file);
      return;
    }

    if (change.deleted)
      result.push({type: 'delete', id: id});
    else if (change.file) {
      if (change.file.labels.trashed != entry.metadata.labels.trashed)
        result.push({type: 'delete', id: id});
      else if ((new Date(change.file.modifiedDate)).getTime() !=
          (new Date(entry.metadata.modifiedDate)).getTime() ||
          change.file.fileSize != entry.metadata.fileSize ||
          change.file.md5Checksum != entry.metadata.md5Checksum)
        // TODO: Include details in metadata.
        result.push({type: 'modify', id: id, metadata: change.file});
      else if (change.file.title != entry.metadata.title)
        result.push({type: 'rename', id: id, metadata: change.file});
      else if (!this.hasSameParents_(change.file, entry.metadata))
        result.push({type: 'move', id: id, metadata: change.file});
    }
  }.bind(this));
  return result;
};

RemoteFileManager.prototype.addPendingChanges_ = function(pendingChanges) {
  // TODO: Consolidate duplicates.
  Array.prototype.push.apply(this.pendingChanges, pendingChanges);
};

RemoteFileManager.prototype.getChanges_ = function(callback) {
  console.assert(this.largestChangeId);
  this.fetchChanges_(function(changes, error) {
    if (error)
      callback(error)
    else {
      var changes = this.parseChanges_(changes);
      this.addPendingChanges_(changes);
      var items = ['pendingChanges', 'largestChangeId'];
      // parseChanges_ will add created entries to idEntryMap.
      if (changes.createdIds.length > 0)
        items.push('entries');
      this.update(callback, items);
    }
  }.bind(this));
};

RemoteFileManager.prototype.getPendingChanges = function(callback) {
  if (this.largestChangeId) {
    this.getChanges_(function(error) {
      if (error)
        callback(null, error);
      else
        callback(this.pendingChanges);
    }.bind(this));
  } else {
    this.scan_(function() {
      Array.prototype.push.apply(this.pendingChanges,
          Object.keys(this.idEntryMap).transform(function(id) {
        return {type: 'create', id: id};
      });
      this.update(function() {
        callback(this.pendingChanges);
      }.bind(this), 'pendingChanges');
    }.bind(this));
  }
};

/**
 * Test whether two files' metadata contains the same parents.
 * @param {object} a The first file's metadata.
 * @param {object} b The second file's metadata.
 */
RemoteFileManager.prototype.hasSameParents_ = function(a, b) {
  if (a.parents.length != b.parents.length)
    return false;
  a.parents.forEach(function(aParent) {
    // If every parent of B does not match this parent of A, they have
    // different parents.
    if (b.parents.every(function(bParent) {
      return aParent.id != bParent.id;
    }))
      return false;
  });
  return true;
};

RemoteFileManager.prototype.getEntry = function(id) {
  return this.idEntryMap[id];
};

RemoteFileManager.prototype.getRoot = function() {
  return this.rootEntry_;
};
