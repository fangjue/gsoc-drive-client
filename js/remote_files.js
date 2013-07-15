/**
 * @fileoverview This file contains code to manage remote files on Google Drive.
 */

'use strict';

function RemoteEntry(metadata) {
  this.metadata = metadata;
  return this;
};

var RemoteFiles = {
  STORAGE_LARGEST_CHANGE_ID: 'remote.largestChangeId',
  STORAGE_IDS: 'remote.ids',
  STORAGE_PENDING_CHANGES: 'remote.pendingChanges',
  STORAGE_ENTRY_PREFIX: 'remote.entry.',
};

RemoteFiles.load = function(callback) {
  var items = {};
  items[RemoteFiles.STORAGE_LARGEST_CHANGE_ID] = 0;
  items[RemoteFiles.STORAGE_IDS] = [];
  items[RemoteFiles.STORAGE_PENDING_CHANGES] = [];
  items[RemoteFiles.STORAGE_LAST_KNOWN_CHANGE] = null;
  chrome.storage.local.get(items, function(items) {
    RemoteFiles.largestChangeId = items[RemoteFiles.STORAGE_LARGEST_CHANGE_ID];
    RemoteFiles.pendingChanges = items[RemoteFiles.STORAGE_PENDING_CHANGES];
    chrome.storage.local.get(items[RemoteFiles.STORAGE_IDS].map(function(id) {
      return RemoteFiles.STORAGE_ENTRY_PREFIX + id;
    }), function(idEntryMap) {
      RemoteFiles.idEntryMap = dictMap(idEntryMap, function(id, entry) {
        return [strStripStart(id, RemoteFiles.STORAGE_ENTRY_PREFIX),
                new RemoteEntry(entry)];
      });
      RemoteFiles.findChildren();
      callback({
        largestChangeId: RemoteFiles.largestChangeId,
        pendingChanges: RemoteFiles.pendingChanges,
        idEntryMap: RemoteFiles.idEntryMap,
        idChildrenMap: RemoteFiles.idChildrenMap
      });
    });
  });
};

RemoteFiles.update = function(callback) {
  var items = dictMap(RemoteFiles.idEntryMap, function(id, entry) {
    return [RemoteFiles.STORAGE_ENTRY_PREFIX + id,
            entry.metadata];
  });
  items[RemoteFiles.STORAGE_IDS] = Object.keys(RemoteFiles.idEntryMap);
  items[RemoteFiles.STORAGE_LARGEST_CHANGE_ID] = RemoteFiles.largestChangeId;
  items[RemoteFiles.STORAGE_PENDING_CHANGES] = RemoteFiles.pendingChanges;
  chrome.storage.local.set(items, callback);
};

RemoteFiles.findChildren = function() {
  var excludedIds = [];
  RemoteFiles.idChildrenMap = {};
  dictForEach(RemoteFiles.idEntryMap, function(id, entry) {
    if (entry.metadata.parents) {
      if (entry.metadata.parents.length == 0)
        excludedIds.push(entry.metadata.id);

      entry.metadata.parents.forEach(function(parent) {
        var id = parent.isRoot ? 'root' : parent.id;
        if (RemoteFiles.idChildrenMap[id])
          RemoteFiles.idChildrenMap[id].push(entry);
        else
          RemoteFiles.idChildrenMap[id] = [entry];
      });
    }
  });

  // This removes folders without parents, such as Chrome Syncable Filesystem.
  excludedIds.forEach(RemoteFiles.removeEntries);
};

RemoteFiles.removeEntries = function(id) {
  (RemoteFiles.idChildrenMap[id] || []).forEach(RemoteFiles.removeEntries);
  delete RemoteFiles.idChildrenMap[id];
  delete RemoteFiles.idEntryMap[id];
};

/**
 * Scan remote files inside My Drive.
 * @param {function} callback Called with the result.
 */
RemoteFiles.scan = function(callback) {
  drive.getAccountInfo({fields: 'largestChangeId'}, function(info, error) {
    if (!info) {
      callback(null, error);
      return;
    }

    RemoteFiles.largestChangeId = info.largestChangeId;

    drive.getAll({q: '\'me\' in owners and trashed = false'},
        function(files) {
      RemoteFiles.idEntryMap = {};
      files.forEach(function(entry) {
        RemoteFiles.idEntryMap[entry.id] = new RemoteEntry(entry);
      });

      RemoteFiles.findChildren();

      callback({
        largestChangeId: RemoteFiles.largestChangeId,
        idEntryMap: RemoteFiles.idEntryMap,
        idChildrenMap: RemoteFiles.idChildrenMap,
      });
    });
  });
};

RemoteFiles.getChanges = function(callback) {
  drive.getChanges({startChangeId: parseInt(RemoteFiles.largestChangeId) + 1,
      includeSubscribed: false}, function(changes, error) {
    if (changes) {
      if (changes.items.length > 0) {
        var firstChange = changes.items[0];
        var lastChange = changes.items[changes.items.length - 1];
        RemoteFiles.pendingChanges = RemoteFiles.pendingChanges.concat(
            changes.items);
      }
      RemoteFiles.largestChangeId = changes.largestChangeId;
      callback({
        largestChangeId: RemoteFiles.largestChangeId,
        pendingChanges: RemoteFiles.pendingChanges,
      });
    } else
      callback(null, error);
  });
};