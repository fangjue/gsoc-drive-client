import logging
import webapp2

class NotificationsHandler(webapp2.RequestHandler):
  def post(self):
    self.response.status = 200
    logging.info(self.request.headers)
    logging.info(self.request.body)

app = webapp2.WSGIApplication([
  (r'/notifications', NotificationsHandler),
])
