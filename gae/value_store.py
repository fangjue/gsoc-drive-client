import json
import os
from google.appengine.ext import ndb

class ValueStore(object):
  class Model(ndb.Model):
    app_version = ndb.StringProperty()
    namespace = ndb.StringProperty()
    content = ndb.TextProperty()

  def __init__(self, namespace, include_app_version=True):
    self._app_version = '*'
    if include_app_version:
      self._app_version = os.environ['CURRENT_VERSION_ID'].split('.', 1)[0]
    self._namespace = namespace

  def _GetKey(self, key):
    return ndb.Key(ValueStore.Model,
                   '%s@%s/%s' % (self._namespace, self._app_version, key))

  def Get(self, key, default_value=None):
    entity = self._GetKey(key).get()
    if entity is None:
      return default_value
    return json.loads(entity.content)

  def GetMulti(self, keys):
    pass

  def Set(self, key, value):
    entity = ValueStore.Model(key=self._GetKey(key),
                              app_version=self._app_version,
                              namespace=self._namespace,
                              content=json.dumps(value))
    entity.put()
