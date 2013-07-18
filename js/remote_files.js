/**
 * @fileoverview This file contains code to manage remote files on Google Drive.
 */

'use strict';

function RemoteEntry(metadata) {
  this.metadata = metadata;
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
};

RemoteFileManager.prototype.load = function(callback) {
  var items = {};
  items[this.STORAGE_LARGEST_CHANGE_ID] = 0;
  items[this.STORAGE_IDS] = [];
  items[this.STORAGE_PENDING_CHANGES] = [];
  items[this.STORAGE_LAST_KNOWN_CHANGE] = null;
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
      callback({
        largestChangeId: this.largestChangeId,
        pendingChanges: this.pendingChanges,
        idEntryMap: this.idEntryMap,
        idChildrenMap: this.idChildrenMap
      });
    }.bind(this));
  }.bind(this));
};

RemoteFileManager.prototype.update = function(callback) {
  var items = dictMap(this.idEntryMap, function(id, entry) {
    return [this.STORAGE_ENTRY_PREFIX + id, entry.toStorage()];
  }.bind(this));
  items[this.STORAGE_IDS] = Object.keys(this.idEntryMap);
  items[this.STORAGE_LARGEST_CHANGE_ID] = this.largestChangeId;
  items[this.STORAGE_PENDING_CHANGES] = this.pendingChanges;
  chrome.storage.local.set(items, callback);
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
RemoteFileManager.prototype.scan = function(callback) {
  this.drive_.getAccountInfo({fields: 'largestChangeId'},
      function(info, error) {
    if (!info) {
      callback(null, error);
      return;
    }

    this.largestChangeId = info.largestChangeId;

    this.drive_.getAll({q: '\'me\' in owners and trashed = false'},
        function(files) {
      this.idEntryMap = {};
      files.forEach(function(entry) {
        this.idEntryMap[entry.id] = new RemoteEntry(entry);
      }.bind(this));

      this.findChildren();

      callback({
        largestChangeId: this.largestChangeId,
        idEntryMap: this.idEntryMap,
        idChildrenMap: this.idChildrenMap,
      });
    }.bind(this));
  }.bind(this));
};

RemoteFileManager.prototype.getChanges = function(callback) {
  this.drive_.getChanges({startChangeId: parseInt(this.largestChangeId) + 1,
      includeSubscribed: false}, function(changes, error) {
    if (changes) {
      if (changes.items.length > 0) {
        var firstChange = changes.items[0];
        var lastChange = changes.items[changes.items.length - 1];
        this.pendingChanges = this.pendingChanges.concat(
            changes.items);
      }
      this.largestChangeId = changes.largestChangeId;
      callback({
        largestChangeId: this.largestChangeId,
        pendingChanges: this.pendingChanges,
      });
    } else
      callback(null, error);
  }.bind(this));
};

RemoteFileManager.parseChanges = function() {
  var createdIds = [];
  var modifiedIds = [];
  var deletedIds = [];
  var movedItems = [];
  this.pendingChanges.forEach(function(change) {
    var entry = this.idEntryMap[change.fileId];
    if (!entry)
      return;

    var id = change.fileId;
    if (change.deleted)
      deletedIds.push(id);
    else if (change.file) {
      if (change.file.labels.trashed != entry.metadata.labels.trashed)
        deletedIds.push(id);
      else if ((new Date(change.file.modifiedDate)).getTime() !=
          (new Date(entry.metadata.modifiedDate)).getTime() ||
          change.file.fileSize != entry.metadata.fileSize ||
          change.file.md5Checksum != entry.metadata.md5Checksum)
        modifiedIds.push(id);
      else if (change.file.title != entry.metadata.title)
        movedItems.push({id: id, newMetadata: change.file});
      else if (!this.hasSameParents_(change.file, entry.metadata))
        movedItems.push({id: id, newMetadata: change.file});
    }
  }.bind(this);
  // TODO: Consolidate duplicates.
  return {
    createdIds: createdIds,
    modifiedIds: modifiedIds,
    deletedIds: deletedIds,
    movedIds: movedIds
  };
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
