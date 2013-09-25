document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('signin').addEventListener('click', function() {
    chrome.identity.getAuthToken({interactive: true}, function(token) {
      if (token) {
        document.getElementById('signin').style.display = 'none';
        document.getElementById('signin-done').style.display = '';
        // success
      } else {
        // error
      }
    });
  });

  document.getElementById('choose-folder').addEventListener('click',
      function() {
    chrome.fileSystem.chooseEntry({type: 'openDirectory', suggestedName: 'My Drive'}, function(root) {
      if (root) {
        var rootId = chrome.fileSystem.retainEntry(root);
        storageSetItem('local', storageKeys.settings.rootEntryId, rootId,
            function() {
          if (chrome.runtime.lastError) {
            // ...
          } else {
            var button = document.getElementById('choose-folder');
            button.textContent = 'Choose another folder';
            chrome.fileSystem.getDisplayPath(root, function(displayPath) {
              document.getElementById('folder-display-path').textContent =
                  displayPath;
            });
          }
        });
      }
    });
  });
});
