"""Validate actual audio samples offline in Qt WebEngine, without a server or speakers."""

import json
import os
from pathlib import Path
import sys

os.environ['QT_QPA_PLATFORM'] = 'offscreen'
os.environ.setdefault(
    'QTWEBENGINE_CHROMIUM_FLAGS', '--no-sandbox --disable-gpu --disable-dev-shm-usage'
)
from PyQt6.QtCore import QTimer, QUrl
from PyQt6.QtWidgets import QApplication
from PyQt6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile, QWebEngineScript

root = Path(__file__).resolve().parents[1]
app = QApplication(sys.argv)
profile = QWebEngineProfile(app)


class Page(QWebEnginePage):
    def javaScriptConsoleMessage(self, level, message, line, source):
        if message.startswith('TEST_RESULT:'):
            result = json.loads(message.split(':', 1)[1])
            print(result, flush=True)
            app.exit(0 if result.get('passed') else 1)
        elif level == QWebEnginePage.JavaScriptConsoleMessageLevel.ErrorMessageLevel:
            print(f'{message} at {source}:{line}', flush=True)
            app.exit(1)


page = Page(profile, app)
source = (root / 'lib/motionflow/main.js').read_text()
audio = source[source.index('class AudioRoute') : source.index('class PlaybackSession')]
script = QWebEngineScript()
script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
script.setSourceCode('const browser = window;\n' + audio)
page.scripts().insert(script)
page.load(QUrl.fromLocalFile(str(root / 'tests/fixtures/motionflow-audio.html')))
QTimer.singleShot(
    30000,
    lambda: (print('FAIL: offline audio test timed out', flush=True), app.exit(1)),
)
result = app.exec()
page.deleteLater()
app.processEvents()
sys.exit(result)
