/**
 * @fileoverview A Google Drive JavaScript library that works in the Chrome
 * Apps platform.
 */

'use strict';

log.registerSource('chromeIdentity');

var GoogleDrive = function(opt_options) {
  if (!opt_options)
    opt_options = {};

  /** @const */ this.DEFAULT_MIME_TYPE = 'application/octet-stream';

  // Chunk sizes must be a multiple of 256 KB.
  // Multiple requests for a single file count as one request.
  /** @const */ this.DEFAULT_UPLOAD_CHUNK_SIZE = 256 * 1024 * 4;
  /** @const */ this.DEFAULT_DOWNLOAD_CHUNK_SIZE = 1024 * 1024 * 4;

  /** @const */ this.DRIVE_API_SERVER =
      'https://www.googleapis.com/';
  /** @const */ this.DRIVE_API_FILES_BASE_URL =
      this.DRIVE_API_SERVER + 'drive/v2/files';
  /** @const */ this.DRIVE_API_FILES_UPLOAD_URL =
      this.DRIVE_API_SERVER + 'upload/drive/v2/files';
  /** @const */ this.DRIVE_API_CHANGES_BASE_URL =
      this.DRIVE_API_SERVER + 'drive/v2/changes';
  /** @const */ this.DRIVE_API_ABOUT_URL =
      this.DRIVE_API_SERVER + 'drive/v2/about';
  /** @const */ this.DRIVE_API_CHANGES_WATCH_URL =
      this.DRIVE_API_SERVER + 'drive/v2/changes/watch';
  /** @const */ this.DRIVE_API_STOP_WATCH_URL =
      this.DRIVE_API_SERVER + 'drive/v2/channels/stop';

  /** @const */ this.DRIVE_API_MAX_RESULTS = 1000;
  // TODO: Figure out the best value for list requests.
  // While larger values save request number quota, it's MUCH SLOWER than
  // the total time of multiple requests.
  /** @const */ this.DRIVE_API_PREFERRED_PAGE_SIZE = 100;
  // Files larger than 1 MB will use resumable upload.
  /** @const */ this.RESUMABLE_UPLOAD_THRESHOLD = 1024 * 1024;
  /** @const */ this.MAX_RETRY = 4;

  this.getToken_ = opt_options.tokenProvider || function(callback) {
    var startTime = new Date();
    chrome.identity.getAuthToken({}, function(token) {
      callback(token);
    });
  };

  this.requestSender_ = new RequestSender();

  this.fields_ = opt_options.fields || {};

  this.pendingResumableUploads_ = {};

  return this;
};

/** @const */ GoogleDrive.MIME_TYPE_FOLDER =
    'application/vnd.google-apps.folder';
GoogleDrive.isFolder = function(file) {
  return file.mimeType == GoogleDrive.MIME_TYPE_FOLDER;
};

GoogleDrive.prototype.getFields_ = function(options, type) {
  if (options.fields)
    return options.fields;
  else
    return this.fields_[type];
};

GoogleDrive.prototype.setFields_ = function(object, options, type) {
  if (this.getFields_(options, type))
    object.fields = this.getFields_(options, type);
};

GoogleDrive.prototype.shallowCopy_ = function(object) {
  var result = {};
  for (var key in object)
    result[key] = object[key];
  return result;
};

/**
 * @typedef {object} DriveAPIError
 * @property {object} tokenError
 * @property {object} xhrError
 */

/**
 * Send a Google Drive API request.
 * @param {string} method Standard HTTP method.
 * @param {string} url The URL of the request.
 * @param {object} options The options of the request.
 * @param {function} callback Called with the result.
 * @param {object} retryCount_ Used internally for expoential backoff.
 */
GoogleDrive.prototype.sendDriveRequest_ = function(method, url, options,
    callback, retryCount_) {
  this.getToken_(function(token) {
    if (!token) {
      callback(null, {tokenError: {details: chrome.runtime.lastError}});
      return;
    }

    if (strStartsWith(url, this.DRIVE_API_SERVER)) {
      // prettyPrint=false is only supported (and makes sense) in Drive API
      // requests. It should not be used when a download request is sent.
      if (!options.queryParameters)
        options.queryParameters = {};
      options.queryParameters.prettyPrint = 'false';
    }

    options.authorization = 'Bearer ' + token;
    this.requestSender_.sendRequest(method, url, options,
        function (xhr, error) {
      if (error && error.xhrError) {
        var driveError;
        try {
          driveError = JSON.parse(error.xhrError.response).error;
        } catch(e) {
        }

        if (driveError)
          error.driveError = driveError;

        if ((error.xhrError.status >= 500 && error.xhrError.status < 600) ||
            (driveError && !driveError.errors.every(function(error) {
              return error.reason != 'rateLimitExceeded' &&
                     error.reason != 'userRateLimitExceeded';
            }))) {
          if (retryCount_ != undefined)
            ++retryCount_;
          else
            retryCount_ = 0;
          if (retryCount_ < this.MAX_RETRY) {
            setTimeoutKeepAlive(this.sendDriveRequest_.bind(this,
                method, url, options, callback, retryCount_),
              Math.round(Math.pow(2, retryCount_) + Math.random()) * 1000);
            return; // Don't invoke the callback. The request is pending.
          }
        }
      }

      callback(xhr, error);
    }.bind(this));
  }.bind(this));
};

/**
 * Send an API request to Google Drive that responds with a Files resource.
 * @param {string} method HTTP method.
 * @param {object} details
 * @param {function} opt_callback Called with the returned file metadata.
 */
GoogleDrive.prototype.sendFilesRequest_ = function(method, details,
    opt_callback) {
  var url = this.DRIVE_API_FILES_BASE_URL;
  var xhr_details = {
    expectedStatus: [200],
    queryParameters: {},
  };

  if (details.upload)
    url = this.DRIVE_API_FILES_UPLOAD_URL;
  if (details.fileId) {
    url += '/' + details.fileId;
    if (details.operation)
      url += '/' + details.operation;
  }

  this.setFields_(xhr_details.queryParameters, details, 'files');
  if (details.uploadType)
    xhr_details.queryParameters.uploadType = details.uploadType;
  if (details.multipartBody)
    xhr_details.multipartBody = details.multipartBody;
  if (details.body)
    xhr_details.body = details.body;
  if (details.contentType)
    xhr_details.contentType = details.contentType;
  if (details.ifMatch)
    xhr_details.ifMatch = details.ifMatch;

  this.sendDriveRequest_(method, url, xhr_details, function(xhr, error) {
    if (opt_callback) {
      if (error)
        opt_callback(null, error);
      else
        opt_callback(JSON.parse(xhr.responseText));
    }
  }.bind(this));
};

/**
 * @param {string} method The method to use: POST to upload a new file, PUT
 *     to update an existing file, PATCH to update metadata of an existing
 *     file.
 * @param {object} options Upload request options.
 * @param {object} opt_metadata A Files resource object that represents the
 *     metadata of the file. No metadata will be sent if omitted.
 * @param {Blob|File} opt_content The content of the file, represented as a
 *     Blob. No content will be sent if omitted.
 * @param {function} opt_callback Called with the file's metadata.
 */
GoogleDrive.prototype.sendUploadRequest_ = function(method, options,
    opt_metadata, opt_content, opt_callback) {
  console.assert(opt_metadata || opt_content);

  if (opt_metadata && opt_content) {
    // Both metadata and content.
    if (opt_content.size > this.RESUMABLE_UPLOAD_THRESHOLD)
      this.sendResumableUploadRequest_(method, options, opt_metadata,
          opt_content, opt_callback);
    else
      this.sendMultipartUploadRequest_(method, options, opt_metadata,
          opt_content, opt_callback);
  } else if (opt_metadata) {
    // Metadata only.
    var filesRequestOptions = {
      body: opt_metadata,
    };
    if (options.fileId)
      filesRequestOptions.fileId = options.fileId;
    if (options.ifMatch)
      filesRequestOptions.ifMatch = options.ifMatch;
    this.sendFilesRequest_(method, filesRequestOptions, opt_callback);
  } else {
    // Content only.
    if (opt_content.size > this.RESUMABLE_UPLOAD_THRESHOLD)
      this.sendResumableUploadRequest_('PUT', options, null, opt_content,
          opt_callback);
    else {
      var filesRequestOptions = {
        uploadType: 'media',
        body: opt_content,
        contentType: opt_content.type || this.DEFAULT_MIME_TYPE,
      };
      if (options.upload)
        filesRequestOptions.upload = options.upload;
      if (options.fileId)
        filesRequestOptions.fileId = options.fileId;
      if (options.ifMatch)
        filesRequestOptions.ifMatch = options.ifMatch;
      this.sendFilesRequest_(method, filesRequestOptions, opt_callback);
    }
  }
};

/**
 * Read the content of a blob.
 * @param {Blob|File} The Blob object to read.
 * @param {string} format 'base64', 'arraybuffer', etc.
 * @param {callback} Called when the operation is completed.
 */
GoogleDrive.prototype.readBlob_ = function(blob, format, callback) {
  var fileReader = new FileReader();
  fileReader.onload = function() {
    if (format == 'base64')
      callback(btoa(fileReader.result));
    else
      callback(fileReader.result);
  };
  if (format == 'base64')
    fileReader.readAsBinaryString(blob);
  else
    fileReader.readAsArrayBuffer(blob);
};

GoogleDrive.prototype.sendMultipartUploadRequest_ = function(method, options,
    metadata, content, opt_callback) {
  this.readBlob_(content, 'base64', function(base64Data) {
    var filesRequestOptions = {
      upload: true,
      uploadType: 'multipart',
      multipartBody: {
        boundary: '--------GoogleDriveClientUploadBoundary',
        parts: [
          {
            contentType: 'application/json',
            content: JSON.stringify(metadata)
          },
          {
            contentType: metadata.type || 'application/octet-stream',
            encoding: 'base64',
            content: base64Data
          }
        ]
      }
    };

    if (options.fileId)
      filesRequestOptions.fileId = options.fileId;
    this.sendFilesRequest_(method, filesRequestOptions, opt_callback);
  }.bind(this));
}

GoogleDrive.prototype.sendResumableUploadRequest_ = function(method, options,
    opt_metadata, content, opt_callback) {
  console.assert(content.size != 0);
  var xhrOptions = {
    queryParameters: {
      uploadType: 'resumable'
    },
    headers: {
      'X-Upload-Content-Type': content.type || this.DEFAULT_MIME_TYPE,
      'X-Upload-Content-Length': content.size
    },
    expectedStatus: [200],
  };

  if (opt_metadata) {
    xhrOptions.body = opt_metadata;
  }
  var url = this.DRIVE_API_FILES_UPLOAD_URL;
  if (options.fileId)
    url += '/' + options.fileId;
  if (options.ifMatch)
    xhrOptions.ifMatch = options.ifMatch;
  this.sendDriveRequest_(method, url, xhrOptions,
      function(xhr, error) {
    if (error) {
      if (opt_callback)
        opt_callback(null, error);
    } else
      this.startResumableUploadSession_(xhr.getResponseHeader('Location'),
          options, content, opt_callback);
  }.bind(this));
};

GoogleDrive.prototype.startResumableUploadSession_ = function(sessionUrl,
    options, content, opt_callback) {
  var chunkSize = options.chunkSize || this.DEFAULT_UPLOAD_CHUNK_SIZE;
  // TODO: Persistent storage for interrupted uploads.
  this.pendingResumableUploads_[sessionUrl] = {
    sessionUrl: sessionUrl,
    chunkSize: chunkSize,
    content: content, 
    callback: opt_callback,
    currentOffset: 0,
    uploadedSize: 0
  };
  this.uploadNextChunk_(sessionUrl);
};

GoogleDrive.prototype.uploadNextChunk_ = function(sessionUrl) {
  var info = this.pendingResumableUploads_[sessionUrl];
  if (!info)
    return;
  var slicedContent = info.content.slice(info.currentOffset,
      info.currentOffset + info.chunkSize);
  this.sendDriveRequest_('PUT', sessionUrl, {
    contentRange: {
      start: info.currentOffset,
      end: info.currentOffset + slicedContent.size - 1,
      total: info.content.size
    },
    body: slicedContent,
    contentType: slicedContent.type || this.DEFAULT_MIME_TYPE,
    expectedStatus: [200, 201, 308],
  }, function(xhr, error) {
    if (error) {
      if (xhr.status == 404) {
        // Upload cannot be resumed any more.
        delete this.pendingResumableUploads_[sessionUrl];
      } else {
        error.resumeId = sessionUrl;
        info.interrupted = true;
      }
      if (info.callback)
        info.callback(null, error);
    } else if (xhr.status == '200' || xhr.status == '201') {
      // Upload is completed.
      if (info.callback) {
        info.callback(JSON.parse(xhr.responseText));
      }
    } else if (xhr.status == 308)
      this.processResumableUploadResponse_(sessionUrl, xhr, info);
  }.bind(this));
};

GoogleDrive.prototype.processResumableUploadResponse_ = function(sessionUrl,
    xhr, info) {
  // The current chunk is uploaded.
  var uploadedRange = xhr.getResponseHeader('Range');
  if (uploadedRange) {
    var uploadedEnd = uploadedRange.substr(uploadedRange.indexOf('-') + 1);
    // Google Drive accepts files with a maximum size of 10 GB, which is
    // still in the range that parseInt can handle.
    info.currentOffset = parseInt(uploadedEnd) + 1;
  } else
    info.currentOffset = 0;
  info.uploadedSize = info.currentOffset;

  this.uploadNextChunk_(sessionUrl);
};

GoogleDrive.prototype.resumeUpload = function(resumeId, content,
    opt_callback) {
  var info = this.pendingResumableUploads_[resumeId];
  if (!info) {
    if (opt_callback)
      opt_callback(null, {});
    return;
  }
  info.content = content;

  this.sendDriveRequest_('PUT', info.sessionUrl,
      {contentRange: {total: content.size}, expectedStatus: [200, 308]},
      function(xhr, error) {
    if (error) {
      if (xhr.status == 404)
        delete this.pendingResumableUploads_[resumeId];
      if (opt_callback)
        opt_callback(null, error);
    } else if (xhr.status == 308)
      this.processResumableUploadResponse_(info.sessionUrl, xhr, info);
    else if (opt_callback)
      opt_callback(JSON.parse(xhr.responseText));
  }.bind(this));
};

/**
 * Send a xxx.list request and handle multi page results.
 * @param {string} method HTTP method to use.
 * @param {string} url The URL of the request.
 * @param {object} options Options for this list request, such as maxmimum
 *     number of results.
 * @param {XHRDetails} xhrOptions XHR options for this request.
 * @param {function} callback Called with complete result on success, partial
 *     result or null on error with error information.
 * @param {object} multiPageOptions_ Used internally by this method. Do not
 *     supply it when you call this method.
 */
GoogleDrive.prototype.sendListRequest_ = function(method, url, options,
    xhrOptions, callback, multiPageOptions_) {
  console.assert((options.pageSize || 0 ) < this.DRIVE_API_MAX_RESULTS);
  console.assert(!(options.oneTimeRequest &&
                   (options.pageSize || options.maxResults)));
  var pageSize;
  if (options.pageSize)
    pageSize = Math.min(options.pageSize,
        options.maxResults || this.DRIVE_API_MAX_RESULTS);
  else
    pageSize = this.DRIVE_API_PREFERRED_PAGE_SIZE;

  if (!xhrOptions.queryParameters)
    xhrOptions.queryParameters = {};
  // Some list requests doesn't support maxResults (eg. properties).
  if (!options.oneTimeRequest)
    xhrOptions.queryParameters.maxResults = pageSize;

  var fields = '';
  if (options.fields)
    fields = options.fields;
  else if (options.fields == '')
    fields = 'nextPageToken';

  if (options.itemsFields) {
    if (fields)
      fields += ',';
    fields += 'items(' + options.itemsFields + ')';
  }

  if (fields) {
    // nextPageToken is required for multi-page list requests.
    if (fields.indexOf('nextPageToken') == -1 && !options.oneTimeRequest)
      fields = 'nextPageToken,' + fields;
    // items is a required fields. Otherwise, the server will respond with
    // 500 Server Error.
    if (fields.indexOf('items') == -1)
      fields = 'items,' + fields;
    xhrOptions.queryParameters.fields = fields;
  }

  if (!multiPageOptions_) {
    multiPageOptions_ = {
      responseSoFar: null,
      nextPageToken: options.nextPageToken,
    };
  }
  if (multiPageOptions_.nextPageToken)
    xhrOptions.queryParameters.pageToken = multiPageOptions_.nextPageToken;

  this.sendDriveRequest_(method, url, xhrOptions, function(xhr, error) {
    if (error)
      callback(multiPageOptions_.responseSoFar, error);
    else {
      var response = JSON.parse(xhr.responseText);
      var items = response.items;
      if (multiPageOptions_.responseSoFar) {
        multiPageOptions_.responseSoFar.items =
            multiPageOptions_.responseSoFar.items.concat(items);
        multiPageOptions_.responseSoFar.nextPageToken = response.nextPageToken;
      } else {
        multiPageOptions_.responseSoFar = response;
      }

      if ((options.maxResults && multiPageOptions_.responseSoFar.items.length >=
          options.maxResults) || options.oneTimeRequest) {
        callback(multiPageOptions_.responseSoFar);
      } else if (response.nextPageToken) {
        multiPageOptions_.nextPageToken = response.nextPageToken;
        this.sendListRequest_(method, url, options, xhrOptions, callback,
            multiPageOptions_);
      } else
        callback(multiPageOptions_.responseSoFar);
    }
  }.bind(this));
};

/**
 * Upload a file to Google Drive.
 * @param {object} metadata File metadata such as description, title, etc.
 * @param {Blob|File} content File content as a Blob.
 * @param {object} options
 * @param {function} opt_callback Called to report progress and status.
 */
GoogleDrive.prototype.upload = function(metadata, content, options,
    opt_callback) {
  this.sendUploadRequest_('POST', {}, metadata, content, opt_callback);
};

/**
 * Get a file's metadata by ID.
 * @param {string} fileId The file's ID.
 * @param {object} options
 * @param {function} callback Called with the file's metadata.
 */
GoogleDrive.prototype.get = function(fileId, options, callback) {
  this.sendFilesRequest_('GET', {
    fileId: fileId,
    fields: options.fields,
    ifMatch: options.etag,
  }, callback);
};

/**
 * Update a file's metadata ond/or content.
 * @param {string} fileId The file's id.
 * @param {object} opt_fullMetadata The file's full updated metadata.
 * @param {object} opt_metadataUpdates The file's metadata to update, only
 *     containing fields that need to be updated. This parameter cannot be used
 *     with opt_content or opt_fullMetadata.
 * @param {Blob|File} opt_content The file's new content.
 * @param {object} opt_options
 * @param {function} opt_callback Called with the updated file's metadata.
 */
GoogleDrive.prototype.update = function(fileId, opt_fullMetadata,
    opt_metadataUpdates, opt_content, opt_options, opt_callback) {
  console.assert(!(opt_fullMetadata && opt_metadataUpdates));
  console.assert(!(opt_metadataUpdates && opt_content));
  if (!opt_options)
    opt_options = {};
  if (opt_metadataUpdates) {
    this.sendUploadRequest_('PATCH', {
      fileId: fileId,
      ifMatch: opt_options.etag
    }, opt_metadataUpdates, null, opt_callback);
  } else if (opt_content || opt_fullMetadata) {
    this.sendUploadRequest_('PUT', {
      fileId: fileId,
      upload: true,
      ifMatch: opt_options.etag
    }, opt_fullMetadata, opt_content, opt_callback);
  }
};

/**
 * Download a file from Google Drive.
 * @param {fileId} The file's id.
 * @param {object} options If |etag| property is specified, it's guaranteed
 *     that the downloaded version of the file matches the specified etag
 *     even if the file is changed during downloading.
 * @param {function} callback Called with the downloaded data.
 */
GoogleDrive.prototype.download = function(fileId, options, callback) {
  if (options.etag) {
    this.get(fileId, {
      fields: 'headRevisionId',
      etag: options.etag,
    }, function(metadata, error) {
      if (error)
        callback(null, error);
      else if (!metadata.headRevisionId)
        callback(null, {});
      else {
        this.getRevision(fileId, metadata.headRevisionId,
            {fields: 'downloadUrl,fileSize'}, function(revision, error) {
          if (error)
            callback(null, error);
          else
            this.downloadAsBlob_(revision, options, callback);
        }.bind(this));
      }
    }.bind(this));
  } else {
    this.get(fileId, {fields: 'downloadUrl,fileSize'}, function(metadata, error) {
      if (error)
        callback(null, error);
      else if (!metadata.downloadUrl)
        callback(null, {});
      else {
        this.downloadAsBlob_(metadata, options, callback);
      }
    }.bind(this));
  }
};

GoogleDrive.prototype.downloadAsBlob_ = function(details, options, callback) {
  if (options.chunkCallback) {
    // Download the file as chunks to save memory for large files.
    this.downloadNextChunkAsBlob_(details.downloadUrl, details.fileSize,
        options.chunkCallback, callback);
  } else {
    // Download the whole file as a Blob.
    this.downloadChunkAsBlob_(details.downloadUrl, null, function(xhr, error) {
      if (error)
        callback(null, error);
      else
        callback(xhr.response);
    });
  }
};

GoogleDrive.prototype.downloadNextChunkAsBlob_ = function(url, fileSize,
    chunkCallback, completedCallback, offset_, realSize_) {
  console.assert(offset_ == undefined || realSize_ == undefined ||
      offset_ < realSize_);
  var chunkSize = this.DEFAULT_DOWNLOAD_CHUNK_SIZE;
  var offset = offset_ == undefined ? 0 : offset_;
  var length = Math.min(fileSize || chunkSize, chunkSize);
  if (offset_ != undefined && realSize_ != undefined)
    length = Math.min(length, realSize_ - offset_);
  // TODO: length == 0 ?

  this.downloadChunkAsBlob_(url, {
    start: offset,
    end: offset + length - 1,
  }, function(xhr, error) {
    function onNextChunkExpected(opt_newCallback) {
      if (opt_newCallback)
        chunkCallback = opt_newCallback;
      if (realSize_ != undefined && offset < realSize_ ||
          realSize_ == undefined && length >= chunkSize) {
        this.downloadNextChunkAsBlob_(url, fileSize, chunkCallback,
            completedCallback, offset, realSize_);
      } else
        completedCallback();
    }

    if (error) {
      chunkCallback(null, function(){}, error);
      completedCallback(error);
    } else {
      // TODO: Make RequestSender return a Response object so that response
      // header parsing can be done within RequestSender.
      var contentRange = xhr.getResponseHeader('Content-Range');
      var match = /bytes\s+(\d*)-(\d*)\/(\d*)/.exec(contentRange);
      if (match && match[3])
        realSize_ = parseInt(match[3]);

      var blob = xhr.response;
      var chunk = {
        data: blob,
        offset: offset,
        length: blob.size,
      };
      offset += blob.size;
      if (realSize_) {
        chunk.totalSize = realSize_;
        chunk.remainingSize = realSize_ - offset;
      }

      if (!chunkCallback(chunk, onNextChunkExpected.bind(this))) {
        onNextChunkExpected.bind(this)();
      }
    }
  }.bind(this));
};

GoogleDrive.prototype.downloadChunkAsBlob_ = function(url, opt_range, callback) {
  this.sendDriveRequest_('GET', url, {
    responseType: 'blob',
    expectedStatus: [200, 206],
    range: opt_range,
  }, callback);
};

/**
 * Create a new folder.
 * @param {string} parentId The parent folder's id.
 * @param {string} title The folder's name.
 * @param {object} options
 * @param {function} opt_callback Called with the created folder's metadata.
 */
GoogleDrive.prototype.createFolder = function(parentId, title, options,
    opt_callback) {
  var metadata = {
    title: title,
    parents: [{id: parentId}],
    mimeType: GoogleDrive.MIME_TYPE_FOLDER,
  };

  if (options.metadata)
    for (var key in options.metadata)
      metadata[key] = options.metadata[key];

  this.sendFilesRequest_('POST', {body: metadata, fields: options.fields},
      opt_callback);
};

/**
 * Move a file or folder to the trash.
 * @param {string} fileId The file's id.
 * @param {object} options
 * @param {function} opt_callback Called with the file's metadata.
 *     the file.
 */
GoogleDrive.prototype.trash = function(fileId, options, opt_callback) {
  var requestOptions = {
    fileId: fileId,
    operation: 'trash',
    fields: options.fields,
  };
  this.sendFilesRequest_('POST', requestOptions, opt_callback);
};

/**
 * Restore a file or folder from the trash.
 * @param {string} fileId The file's id.
 * @param {object} options
 * @param {function} opt_callback Called with the file's metadata.
 *     the file.
 */
GoogleDrive.prototype.untrash = function(fileId, options, opt_callback) {
  var requestOptions = {
    fileId: fileId,
    operation: 'untrash',
    fields: options.fields,
  };
  this.sendFilesRequest_('POST', requestOptions, opt_callback);
};

/**
 * Permanently delete a file or a folder including everything in the folder
 * (even if some files also belong to other folders). When deleting a folder,
 * deletion of files inside the folder may be yet to finish when the callback
 * is called.
 * @param {string} fileId The file's id.
 * @param {function} opt_callback Called when the request is completed.
 */
GoogleDrive.prototype.remove = function(fileId, opt_callback) {
  this.sendDriveRequest_('DELETE',
      this.DRIVE_API_FILES_BASE_URL + '/' + fileId, {}, function(xhr, error) {
    if (opt_callback)
      opt_callback(error);
  });
};

/**
 * Get all children under a folder specified by |parentId|.
 * @param {string} parentId
 * @param {object} options
 * @param {function} callback Called with files' metadata.
 */
GoogleDrive.prototype.getChildren = function(parentId, options, callback) {
  // TODO: options: {populate: false} to retrieve child ids only.
  options = this.shallowCopy_(options);
  var q = '\'' + parentId + '\' in parents';
  if (options.q)
    options.q = options.q + ' and ' + q;
  else
    options.q = q;
  this.getAll(options, callback);
};

/**
 * Get all files in the Google Drive account that satisfy all conditions given.
 * @param {object} options
 * @param {function} callback Called with the files' metadata.
 */
GoogleDrive.prototype.getAll = function(options, callback) {
  // TODO: Support object-like filters and convert them to q.
  var listOptions = {
    fields: '',
    pageSize: options.pageSize,
    maxResults: options.maxResults,
  };
  var xhrOptions = {queryParameters: {}};
  if (options.q)
    xhrOptions.queryParameters.q = options.q;
  listOptions.itemsFields = this.getFields_(options, 'files');

  this.sendListRequest_('GET', this.DRIVE_API_FILES_BASE_URL, listOptions,
      xhrOptions, function(result, error) {
    if (error)
      callback(null, error);
    else
      callback(result.items, error);
  }.bind(this));
};

/**
 * Get basic information of this Drive account, including user information,
 * quota usage, latest change id, etc.
 * @param {object} options
 * @param {function} callback Called with an About Resource.
 */
GoogleDrive.prototype.getAccountInfo = function(options, callback) {
  var xhrOptions = {
    expectedStatus: [200],
    queryParameters: {},
  };
  this.setFields_(xhrOptions.queryParameters, options, 'about');
  this.sendDriveRequest_('GET', this.DRIVE_API_ABOUT_URL,
      xhrOptions, function(xhr, error) {
    if (error)
      callback(null, error);
    else
      callback(JSON.parse(xhr.responseText));
  }.bind(this));
};

/**
 * Get the value of a custom file property.
 * @param {string} fileId The file's id.
 * @param {string} propertyKey Property key.
 * @param {boolean} isPublic Whether this property is visible to all apps or
 *     only accessible to the app that creates it.
 * @param {function} callback Called with the property value.
 */
GoogleDrive.prototype.getProperty = function(fileId, propertyKey, isPublic,
    callback) {
  var url = this.DRIVE_API_FILES_BASE_URL + '/' + fileId +
      '/properties/' + propertyKey;
  this.sendDriveRequest_('GET', url, {
    queryParameters: {
      visibility: isPublic ? 'PUBLIC' : 'PRIVATE',
      fields: 'value'
    },
    expectedStatus: [200],
  }, function(xhr, error) {
    if (error)
      callback(null, error);
    else
      callback(JSON.parse(xhr.responseText).value);
  }.bind(this));
};

/**
 * Get the value of a custom file property.
 * @param {string} fileId The file's id.
 * @param {string} propertyKey Property key.
 * @param {boolean} isPublic Whether this property is visible to all apps or
 *     only accessible to the app that creates it.
 * @param {function} opt_callback Called with the property value.
 */
GoogleDrive.prototype.setProperty = function(fileId, propertyKey, isPublic,
    value, opt_callback) {
  var url = this.DRIVE_API_FILES_BASE_URL + '/' + fileId + '/properties';
  // properties.insert request works as expected even if the property
  // already exists.
  this.sendDriveRequest_('POST', url, {
    body: {
      key: propertyKey,
      value: value,
      visibility: isPublic ? 'PUBLIC' : 'PRIVATE',
    },
    expectedStatus: [200],
  }, function(xhr, error) {
    if (opt_callback) {
      if (error)
        opt_callback(null, error);
      else
        opt_callback(JSON.parse(xhr.responseText));
    }
  }.bind(this));
};

/**
 * @typedef {CommonDriveOptions} GetChangesOptions
 * @property {string} startChangeId Required. Change id to start listing change
 *     from.
 * @property {boolean} includeDeleted Whether to include deleted files. The
 *     default value is true.
 * @property {boolean} includeSubscribed Whether to include files in 'Shared
 *     with me'. The default value is true.
 */

/**
 * Get a list of changes since the specified change id.
 * @param {GetChangesOptions} options
 * @param {function} callback
 */
GoogleDrive.prototype.getChanges = function(options, callback) {
  console.assert(options.startChangeId);

  var filesFields = this.getFields_(options, 'files');
  if (filesFields)
    filesFields = 'file(' + filesFields + ')';
  else
    filesFields = 'file';

  var listFields = {
     fields: 'largestChangeId',
     itemsFields: 'id,fileId,deleted,' + filesFields,
     pageSize: options.pageSize,
     maxResults: options.maxResults,
  };

  var xhrOptions = {
    queryParameters: {
      startChangeId: options.startChangeId
    }
  };

  if (options.includeDeleted == false)
    xhrOptions.queryParameters.includeDeleted = 'false';
  if (options.includeSubscribed == false)
    xhrOptions.queryParameters.includeSubscribed = 'false';

  this.sendListRequest_('GET', this.DRIVE_API_CHANGES_BASE_URL, listFields,
      xhrOptions, callback);
};

GoogleDrive.prototype.getRevision = function(fileId, revisionId, options,
    callback) {
  var url = this.DRIVE_API_FILES_BASE_URL + '/' + fileId +
      '/revisions/' + revisionId;
  var xhr_options = {
    expectedStatus: [200],
    queryParameters: {}
  };
  this.setFields_(xhr_options.queryParameters, options, 'revisions');
  this.sendDriveRequest_('GET', url, xhr_options,
      function(xhr, error) {
    if (error)
      callback(null, error);
    else
      callback(JSON.parse(xhr.responseText));
  }.bind(this));
};

/**
 * @typedef {object} DriveWatchOptions
 * @property {string} fileId The id of the file to watch. All changes (including
 *     subscribed files and deleted files) will be watched if this property is
 *     omitted.
 * @property {string} channelId A string that uniquely identifies this watch
 *     channel. It seems that only numbers, alphabets and hyphen ('-') can be
 *     included in the channel id. It may not contain more than 64 charecters.
 * @property {string} receivingUrl The URL to receive notifications.
 * @property {string} token Optional. An arbitrary string value with no more
 *     than 256 characters.
 * @property {integer} ttl The number of seconds of time-to-live value to
 *     request.
 */

/**
 * Start watching all changes made to files in Google Drive. Change
 * notifications will be sent to the specified URL. For more details, please
 * read https://developers.google.com/drive/push.
 * @param {DriveWatchOptions} options Details of the watch request.
 * @param {function} callback Called with the response.
 */
GoogleDrive.prototype.watchChanges = function(options, callback) {
  console.assert(options.channelId && options.receivingUrl &&
      options.channelId.length <= 64);
  console.assert((options.token || '').length <= 256);
  var url = this.DRIVE_API_CHANGES_WATCH_URL;
  var xhrOptions = {
    body: {
      id: options.channelId,
      type: 'web_hook',
      address: options.receivingUrl,
    },
    queryParameters: {},
  };

  if (options.fileId)
    url = this.DRIVE_API_FILES_BASE_URL + '/' + options.fileId + '/watch';
  if (options.token)
    xhrOptions.body.token = options.token;
  if (options.ttl)
    xhrOptions.body.params = {ttl: options.ttl};
  this.setFields_(xhrOptions.queryParameters, options, 'watch');

  this.sendDriveRequest_('POST', url, xhrOptions,
      function(xhr, error) {
    if (error)
      callback(null, error);
    else
      callback(JSON.parse(xhr.responseText));
  });
};

/**
 * Stop receiving notifications on the specified watching channel and resource.
 * Read https://developers.google.com/drive/push for more details.
 * @param {string} channelId The channel id specified in and returned by
 *     the watch request.
 * @param {string} resourceId The resource id returned by the watch request.
 */
GoogleDrive.prototype.stopWatch = function(channelId, resourceId,
    opt_callback) {
  this.sendDriveRequest_('POST', this.DRIVE_API_STOP_WATCH_URL, {body: {
    id: channelId,
    resourceId: resourceId,
  }}, function(xhr, error) {
    if (opt_callback)
      opt_callback(error);
  });
};
