'use strict';

log.registerSource('SyncEngine');

function SyncEngine(localRootEntry) {
  this.idle_ = true;
  this.local_ = new LocalFileManager(localRootEntry);
  this.remote_ = new RemoteFileManager();
  this.pushNotificationHandler = new PushNotificationHandler();
  this.tasks_ = new TaskQueue();
  this.tasks_.setMaxParallelTasks('upload', 2);
  this.tasks_.setMaxParallelTasks('download', 2);
  this.tasks_.setMaxParallelTasks('local', 100);
  this.tasks_.setMaxParallelTasks('remote', 5);
}

SyncEngine.prototype.init = function(callback) {
  asyncEvery1([this.local_, this.remote_], function(manager, callback) {
    manager.load(callback);
  }, function(errors) {
    var error = errors[0] || errors[1];
    if (error)
      callback(error);
    else
      callback();
  });
};

SyncEngine.prototype.fetchChanges = function(callback) {
  this.localChanges_ = undefined;
  asyncCallEvery([function(done) {
    this.local_.getPendingChanges(function(localChanges, error) {
      this.localChanges_ = localChanges;
      done(error);
    }.bind(this));
  }.bind(this), function(done) {
    this.remote_.getPendingChanges(function(changes, error) {
      this.remoteChanges_ = changes;
      done(error);
    }.bind(this));
  }.bind(this)], function(results) {
    if (!this.localChanges_ || !this.remoteChanges_)
      callback(results[0][0] || results[0][1]);
    else
      callback();
  }.bind(this));
};

SyncEngine.prototype.getEmptyChildren_ = function() {
  return {
    created: {},
    deleted: {},
    modified: {},
    movedTo: {},
    movedFrom: {},
    renamed: {},
    unchanged: {},
  };
};

SyncEngine.prototype.findChildren_ = function(parent, key) {
  for (var type in parent.children)
    if (parent.children[type][key])
      return {type: type, child: parent.children[type][key]};
};

SyncEngine.prototype.createChangeTree_ = function() {
  var root = {
    localTitle: '',
    remoteId: 'root',
    children: this.getEmptyChildren_(),
  };

  this.localChanges_.createdPaths.forEach(function(path) {
    this.appendLocalChange_(root, path, 'created');
  }.bind(this));
  this.localChanges_.deletedPaths.forEach(function(path) {
    this.appendLocalChange_(root, path, 'deleted');
  }.bind(this));
  this.localChanges_.modifiedPaths.forEach(function(path) {
    this.appendLocalChange_(root, path, 'modified');
  }.bind(this));

  return root;
};

SyncEngine.prototype.appendLocalChange_ = function(root, path, type) {
  var components;
  var parent = root;
  var localPath = '';

  if (path.substr(-1) == '/') {
    components = path.substr(0, path.length - 1).split('/');
    components[components.length - 1] += '/';
  } else
    components = path.split('/');

  for (var i = 0; i < components.length - 1; ++i) {
    var localTitle = components[i] + '/';
    localPath += localTitle;

    if (parent.children.created[localTitle])
      parent = parent.children.created[localTitle];
    else if (parent.children.unchanged[localTitle])
      parent = parent.children.unchanged[localTitle];
    else {
      parent = parent.children.unchanged[localTitle] = {
        localTitle: localTitle,
        children: this.getEmptyChildren_(),
      };
    }
  }

  var fileTitle = components[i];
  localPath += fileTitle;
  var node = {
    localTitle: fileTitle,
  };
  if (fileTitle.substr(-1) == '/')
    node.children = this.getEmptyChildren_();
  console.log(localPath);
  var entry = this.local_.getKnownEntryByPath(localPath);
  if (entry)
    node.localEntry = entry;
  parent.children[type][fileTitle] = node;
};

SyncEngine.prototype.appendRemoteChange_ = function(root, id, change) {
    var paths = this.remote_.findPaths(id);
    paths.forEach(function(path) {
      var parent = root;
      console.assert(path[0] == 'root');
      path.slice(1).forEach(function(component) {
      }.bind(this));
    }.bind(this));
};

// TODO: Move this into RemoteFileManager?
SyncEngine.prototype.classifyRemoteChanges_ = function() {
  var result = {
    created: [],
    modified: [],
    renamed: [],
    moved: [],
    deleted: [],
  };

  dictForEach(this.remoteChanges_, function(id, change) {
    if (change.created)
      result.created.push(id);
    else if (change.deleted)
      result.deleted.push(id);
    else {
      if (change.modified)
        result.modified.push(id);
      if (change.renamedFrom && change.renamedTo)
        result.renamed.push(id);
      if (change.movedFrom && change.movedTo)
        result.moved.push(id);
    }
  }.bind(this));

  return result;
};

SyncEngine.prototype.processPendingChanges = function(callback) {
  console.assert(this.localChanges_ && this.remoteChanges_ &&
      this.classifiedRemoteChanges_);

  this.classifiedRemoteChanges_.created.forEach(function(id) {
    var change = this.remoteChanges_[id];
    var slotName = 'local';
    if (change.newEntry.fileSize)
      slotName = 'download';
    this.tasks_.queue(slotName, 'remote-' + id,
        this.handleRemoteCreate_.bind(this, id, change.newEntry));
  }.bind(this));
  /*
    var change = this.remote_.getPendingChange(id);
    if (!change)
      return; // 'continue'

    // At first, we assume this is a simple operation so that synchronizing
    // this item only needs some local operations. This includes deleting,
    // moving and renaming.
    var slotName = 'local';
    // Creating and modifying involves downloading file data, if any.
    if ((change.created || change.modified) && change.fileSize)
      slotName = 'download';
    this.tasks_.queue(slotName, 'remote-' + id,
        this.handleRemoteChange.bind(this, change.id, change));
  }.bind(this));

  // TODO: Detecting moved files is needed.
  this.localChanges_.createdPaths.forEach(function(path) {
    // By default, created local files need to be uploaded to remote.
    var slot = 'upload';
    var newEntry = this.local_.getCurrentEntryByPath(path);
    // Only a simple Drive request is needed if it's a directory or an empty
    // file.
    if (newEntry.isDirectory || !newEntry.size)
      slot = 'remote';
    this.tasks_.queue(slot, 'local-' + path,
        this.handleLocalCreate.bind(this, path, newEntry));
  }.bind(this));

  this.localChanges_.deletedPaths.forEach(function(path) {
    this.tasks_.queue('remote', 'local-' + path,
        this.handleLocalDelete.bind(this, path));
  }.bind(this));

  this.localChanges_.modifiedPaths.forEach(function(path) {
    this.tasks_.queue('upload', 'local-' + path,
        this.handleLocalModify.bind(this, path));
  }.bind(this));

  */

  this.tasks_.run(callback);
};

SyncEngine.prototype.sync = function(callback) {
  this.fetchChanges(function(error) {
    if (error)
      callback(error);
    else {
      this.classifiedRemoteChanges_ = this.classifyRemoteChanges_();
      this.processPendingChanges(callback);
    }
  }.bind(this));
};

/*
SyncEngine.prototype.handleRemoteChange = function(remoteId, change, callback) {
  if (change.deleted)
    this.handleRemoteDelete(remoteId, callback);
  else if (change.created)
    this.handleRemoteCreate(change.file, callback);
  else
    this.handleRemoteUpdate(remoteId, change, callback);
};*/

SyncEngine.prototype.handleRemoteDelete = function(remoteId, callback) {
  // TODO
  console.log('Remote delete', remoteId);
  _randomDelay(callback);
};

SyncEngine.prototype.handleRemoteCreate_ = function(id, newEntry, callback) {
  var paths = this.remote_.findPaths(id);
  if (paths.length == 0)
    return {completed: true};

  var blockedOn = [];
  for (var i = 0; i < newEntry.parents.length; ++i) {
    var parentId = newEntry.parents[i];
    if (parentId == 'root')
      continue;
    if (this.classifiedRemoteChanges_.created.indexOf(parentId) != -1)
      blockedOn.push('remote-' + parentId);
    else if (this.classifiedRemoteChanges_.deleted.indexOf(parentId)) {
      // NOTREACHED
      console.warn('NOTREACHED');
      log.SyncEngine.warn('Created entry ' + id + ' has deleted parent ' +
          parentId);
      this.remote_.ignorePendingChange(id);
      return {completed: true};
    }
  }
  if (blockedOn.length > 0) {
    console.log('New entry ' + newEntry.title + ' blocked on', blockedOn);
    return {blockedOn: blockedOn};
  }

  console.log('New entry ' + newEntry.title + ' has paths', paths);
  var parentPaths = this.remotePathsToLocalPaths_(paths.map(function(path) {
    var withoutSelf = path.concat();
    withoutSelf.pop();
    return withoutSelf;
  }));

  asyncEvery1(parentPaths, function(parentPath, callback) {
    this.local_.createEntry(parentPath, newEntry.title, newEntry.isFolder, id,
        callback);
  }.bind(this), function(results) {
    console.log(results);
    this.remote_.ignorePendingChange(id, callback);
  }.bind(this));
};

SyncEngine.prototype.remotePathsToLocalPaths_ = function(remotePaths) {
  return remotePaths.map(function(path) {
    var unknownIds = [];
    var localPath = path.map(function(id) {
      var entry = this.remote_.getEntry(id);
      if (entry)
        return entry.localTitle || entry.title;
      unknownIds.push(id);
      return null;
    }.bind(this)).join('/');
    if (localPath == '')
      localPath = '/';
    return localPath;
  }.bind(this));
};

// 'Update' means what drive.files.update can do, including update file title,
// parents, content, etc.
SyncEngine.prototype.handleRemoteUpdate = function(remoteId, change, callback) {
  // TODO
  console.log('Remote update', remoteId, change);
  _randomDelay(callback);
};

SyncEngine.prototype.handleLocalCreate = function(path, newEntry, callback) {
  // TODO
  console.log('Local create', path, newEntry);
  _randomDelay(callback);
};

SyncEngine.prototype.handleLocalDelete = function(path, callback) {
  // TODO
  console.log('Local delete', path);
  _randomDelay(callback);
};

SyncEngine.prototype.handleLocalModify = function(path, callback) {
  // TODO
  console.log('Local modify', path);
  _randomDelay(callback);
};

SyncEngine.prototype.syncFolderToLocal = function(id, parentPaths, callback) {
  // ...
  /*asyncEvery1(parentPaths, function(path, callback) {
    var parentLocalPath = this.getLocalPath(path.slice(1));
    if (parentLocalPath) {
      //var parentLocalEntry = this.local_.
    }
  }.bind(this), function() {
  });*/
  callback();
};

SyncEngine.prototype.getLocalPath = function(remotePath) {
  var localPath = '';
  for (var i = 0; i < remotePath.length; ++i) {
    var title = this.getLocalTitle(remotePath[i]);
    if (title != null)
      localPath += '/' + title;
    else {
      localPath = null;
      break;
    }
  }
  return localPath;
};

SyncEngine.prototype.getLocalTitle = function(remoteId) {
  var entry = this.remote_.getEntry(remoteId);
  if (entry) {
    if (entry.localTitle != undefined)
      return entry.localTitle;

    // TODO: Replace invalid characters in file names.
    return entry.metadata.title;
  }

  return null;
};

// Called by the event page.
SyncEngine.prototype.scanFiles = function(areas) {
};

SyncEngine.prototype.isIdle = function() {
  return this.idle_;
};
