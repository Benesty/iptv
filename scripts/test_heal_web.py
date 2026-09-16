#!/usr/bin/env python3
"""Regression: a decodable live stream can still be unusable in Beneflix."""
import json
import subprocess
import unittest
from unittest.mock import patch
import heal


class BrowserCompatibility(unittest.TestCase):
    def probe(self, streams, returncode=0):
        result = subprocess.CompletedProcess([], returncode, json.dumps({'streams': streams}), '')
        with patch.object(heal, 'FFPROBE', 'ffprobe'), patch.object(heal.subprocess, 'run', return_value=result):
            return heal.compatible_web('https://example.com/live.m3u8')

    def test_h264_aac(self):
        self.assertTrue(self.probe([{'codec_type':'video','codec_name':'h264'}, {'codec_type':'audio','codec_name':'aac'}]))

    def test_browser_incompatible_codecs(self):
        for video, audio in [('mpeg2video','mp2'), ('hevc','aac'), ('h264','ac3'), ('h264','mp2')]:
            with self.subTest(video=video, audio=audio):
                self.assertFalse(self.probe([{'codec_type':'video','codec_name':video}, {'codec_type':'audio','codec_name':audio}]))

    def test_missing_tracks_and_mixed_video_variants(self):
        for streams in [[], [{'codec_type':'video','codec_name':'h264'}], [{'codec_type':'audio','codec_name':'aac'}],
                        [{'codec_type':'video','codec_name':'h264'}, {'codec_type':'video','codec_name':'hevc'}, {'codec_type':'audio','codec_name':'aac'}]]:
            self.assertFalse(self.probe(streams))

    def test_probe_failures_are_not_accepted(self):
        self.assertFalse(self.probe([], returncode=1))
        with patch.object(heal, 'FFPROBE', None):
            self.assertFalse(heal.compatible_web('https://example.com/live.m3u8'))
        for error in [subprocess.TimeoutExpired('ffprobe',40), OSError('unavailable')]:
            with patch.object(heal, 'FFPROBE', 'ffprobe'), patch.object(heal.subprocess, 'run', side_effect=error):
                self.assertFalse(heal.compatible_web('https://example.com/live.m3u8'))

    def test_advancing_mpeg2_stream_is_not_a_repair(self):
        with patch.object(heal, 'probe', return_value=('ok','','media',('1','seg',6))), \
             patch.object(heal.time, 'sleep'), patch.object(heal, 'playlist_progress', return_value='avance'), \
             patch.object(heal, 'compatible_web', return_value=False):
            self.assertFalse(heal.validate_candidate('https://example.com/live.m3u8'))

    def test_repaired_sources_cannot_return_to_known_bad_urls(self):
        for channel, url in [('DisneyChannel.us','http://212.5.144.156/disney/index.m3u8'),
                             ('AMC.us','http://23.239.31.26:8989/amc/index.m3u8')]:
            with patch.object(heal, 'REGISTRY', {channel:[url]}), patch.object(heal, 'validate_candidate', return_value=True) as validate:
                self.assertIsNone(heal.find_replacement(channel,channel,'current',{},{}))
                validate.assert_not_called()

if __name__ == '__main__':
    unittest.main()
