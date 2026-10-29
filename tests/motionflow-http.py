"""Loopback fixture-server regressions; no browser, GPU or real helper is started."""
from pathlib import Path
import base64
import functools
import http.client
import http.server
import runpy
import tempfile
import threading
import unittest

Files = runpy.run_path(str(Path(__file__).with_name('youtube-motionflow.py')))['Files']


class FixtureServerTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        for name, text in [('robots.txt', 'plain robots'), ('player.html', 'player'), ('asset.txt', 'asset')]:
            (self.root/name).write_text(text)
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Files,directory=self.folder.name))
        self.server.quality_output = self.root
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.addCleanup(self.clean)

    def clean(self):
        self.server.shutdown();self.thread.join();self.server.server_close();self.folder.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=2)
        try:
            connection.request(method,path,body=body,headers=headers or {})
            response=connection.getresponse()
            return response.status,response.read()
        finally:connection.close()

    def test_malformed_exports_return_400_and_valid_requests_still_work(self):
        self.assertEqual(self.request('POST','/quality-image/bad.png',b'not-base64!')[0],400)
        self.assertFalse((self.root/'bad.png').exists())
        for length in ['invalid','-1']:
            self.assertEqual(self.request('POST','/quality-image/bad.png',b'',{'Content-Length':length})[0],400)
        payload=b'exported image bytes'
        self.assertEqual(self.request('POST','/quality-image/good.png',base64.b64encode(payload))[0],204)
        self.assertEqual((self.root/'good.png').read_bytes(),payload)

    def test_invalid_host_scenario_survives_subrequests_and_resets_per_watch(self):
        self.assertEqual(self.request('GET','/watch?v=host-invalid')[0],200)
        self.assertEqual(self.request('GET','/asset.txt')[0],200)
        self.assertIn(b'Unexpected HTML',self.request('GET','/robots.txt')[1])
        self.assertEqual(self.request('GET','/watch?v=test24')[0],200)
        self.assertEqual(self.request('GET','/robots.txt')[1],b'plain robots')


if __name__ == '__main__':unittest.main()
