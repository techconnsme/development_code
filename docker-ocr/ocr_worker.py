#!/usr/bin/env python3
"""
OPCC CRM OCR Worker
Connects to Worker via WebSocket (NAT traversal), receives file upload notifications,
downloads PDFs, extracts text with pdftotext, posts results back via API.

Usage:
  python3 ocr_worker.py --url wss://your-domain.com/api/ws --email your@email.com --password your_password

Environment:
  Requires: pdftotext (poppler-utils)
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import urllib.request

try:
    import aiohttp
    import websockets
except ImportError:
    print("Install dependencies: pip install -r requirements.txt")
    sys.exit(1)


class OCRWorker:
    def __init__(self, api_base: str, email: str, password: str):
        self.api_base = api_base.rstrip('/')
        self.email = email
        self.password = password
        self.token: str | None = None
        self.ws_url = self.api_base.replace('https://', 'wss://').replace('http://', 'ws://') + '/api/ws'
        self.session: aiohttp.ClientSession | None = None

    async def login(self) -> bool:
        """Authenticate and get JWT token."""
        async with aiohttp.ClientSession() as s:
            async with s.post(f'{self.api_base}/api/auth/login', json={
                'email': self.email, 'password': self.password,
            }) as r:
                if r.status != 200:
                    print(f'Login failed: {await r.text()}')
                    return False
                data = await r.json()
                self.token = data['token']
                self.user_id = data.get('user', {}).get('id', '')
                print(f'Logged in as {self.email} ({self.user_id})')
                return True

    async def download_file(self, file_id: str) -> bytes | None:
        """Download file from API."""
        async with self.session.get(
            f'{self.api_base}/api/file-storage/{file_id}/download',
            headers={'Authorization': f'Bearer {self.token}'},
        ) as r:
            if r.status != 200:
                print(f'  Download failed: HTTP {r.status}')
                return None
            return await r.read()

    def extract_text(self, pdf_bytes: bytes) -> str:
        """Extract text from PDF using pdftotext."""
        with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as f:
            f.write(pdf_bytes)
            pdf_path = f.name

        txt_path = pdf_path.replace('.pdf', '.txt')
        try:
            result = subprocess.run(
                ['pdftotext', '-layout', pdf_path, txt_path],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode != 0:
                print(f'  pdftotext error: {result.stderr.strip()}')
                return ''

            with open(txt_path, 'r', encoding='utf-8', errors='replace') as f:
                text = f.read()
            return text
        except FileNotFoundError:
            print('  ERROR: pdftotext not found. Install poppler-utils.')
            return ''
        except subprocess.TimeoutExpired:
            print('  pdftotext timed out')
            return ''
        finally:
            os.unlink(pdf_path)
            if os.path.exists(txt_path):
                os.unlink(txt_path)

    async def post_ocr_result(self, file_id: str, ocr_text: str, ocr_status: str):
        """Post OCR results back to API."""
        async with self.session.post(
            f'{self.api_base}/api/file-storage/{file_id}/ocr-result',
            headers={'Authorization': f'Bearer {self.token}'},
            json={'ocr_text': ocr_text, 'ocr_status': ocr_status},
        ) as r:
            if r.status == 200:
                data = await r.json()
                print(f'  Updated: status={data.get("ocr_status")}, text_len={len(ocr_text)}')
            else:
                print(f'  Update failed: HTTP {r.status} {await r.text()}')

    async def process_file(self, file_id: str, filename: str, file_type: str):
        """Download, extract text, and post results."""
        print(f'Processing {filename} ({file_type})...')

        # Only process PDFs and images
        is_pdf = 'pdf' in file_type
        is_image = any(t in file_type for t in ['image', 'png', 'jpg', 'jpeg', 'gif', 'webp'])

        if not is_pdf and not is_image:
            print(f'  Skipped: unsupported type {file_type}')
            await self.post_ocr_result(file_id, '', 'skipped')
            return

        data = await self.download_file(file_id)
        if not data:
            await self.post_ocr_result(file_id, '', 'failed')
            return

        if is_pdf:
            text = self.extract_text(data)
            status = 'completed' if len(text) > 20 else ('unclear' if text else 'failed')
        else:
            # Images: would need AI OCR, skip for now (handled by Worker)
            print('  Image OCR handled by Worker (DeepSeek)')
            return

        await self.post_ocr_result(file_id, text, status)

    async def process_backlog(self):
        """Process existing files with skipped/failed OCR status."""
        print('Checking for backlog files...')
        async with self.session.get(
            f'{self.api_base}/api/file-storage?limit=100',
            headers={'Authorization': f'Bearer {self.token}'},
        ) as r:
            if r.status != 200:
                print(f'Failed to fetch files: {r.status}')
                return
            data = await r.json()
            files = data.get('data', [])
            backlog = [f for f in files if f.get('ocr_status') in ('skipped', 'pending', 'failed') and 'pdf' in (f.get('file_type') or '')]
            if not backlog:
                print('No backlog files to process')
                return
            print(f'Found {len(backlog)} backlog files')
            for f in backlog:
                await self.process_file(f['id'], f.get('filename', ''), f.get('file_type', ''))
                await asyncio.sleep(0.5)  # Rate limit

    async def handle_message(self, message: str):
        """Handle incoming WebSocket message."""
        try:
            data = json.loads(message)
        except json.JSONDecodeError:
            return

        msg_type = data.get('type')

        if msg_type == 'connected':
            print(f'Connected to server (user: {data.get("userId")})')

        elif msg_type == 'ocr_request':
            file_id = data.get('file_id')
            filename = data.get('filename', '')
            file_type = data.get('file_type', '')
            print(f'\nReceived OCR request: {filename}')
            await self.process_file(file_id, filename, file_type)

        elif msg_type == 'pong':
            pass  # Heartbeat response

    async def run(self):
        """Main loop: connect to WebSocket and listen."""
        if not await self.login():
            return

        self.session = aiohttp.ClientSession()
        ws_url = f'{self.ws_url}?token={self.token}'

        print(f'Connecting to {ws_url.split("?")[0]}...')

        try:
            async with websockets.connect(ws_url, ping_interval=30, ping_timeout=10) as ws:
                # Auth via first message (query param may not survive WebSocket upgrade)
                await ws.send(json.dumps({'type': 'auth', 'token': self.token}))

                # Wait for connected confirmation
                msg = await asyncio.wait_for(ws.recv(), timeout=15)
                data = json.loads(msg)
                if data.get('type') == 'connected':
                    print(f'WebSocket authenticated as {data.get("userId")}')
                else:
                    print(f'Unexpected message: {data}')

                # Process backlog
                await self.process_backlog()

                # Listen for OCR requests
                async for message in ws:
                    await self.handle_message(message)

        except websockets.ConnectionClosed as e:
            print(f'WebSocket closed: {e.code} {e.reason}')
        except Exception as e:
            print(f'WebSocket error: {e}')
        finally:
            if self.session:
                await self.session.close()

    async def run_with_reconnect(self, max_retries: int = 0):
        """Run with automatic reconnection."""
        retries = 0
        while max_retries == 0 or retries < max_retries:
            await self.run()
            retries += 1
            delay = min(5 * retries, 60)
            print(f'Reconnecting in {delay}s... (attempt {retries})')
            await asyncio.sleep(delay)
            # Re-login on reconnect
            if not await self.login():
                continue


def main():
    parser = argparse.ArgumentParser(description='OPCC CRM OCR Worker')
    parser.add_argument('--url', default='https://opcc-crm.techforliving.net', help='API base URL')
    parser.add_argument('--email', required=True, help='Login email')
    parser.add_argument('--password', required=True, help='Login password')
    args = parser.parse_args()

    print('=== OPCC CRM OCR Worker ===')
    print('Press Ctrl+C to stop\n')

    worker = OCRWorker(args.url, args.email, args.password)
    try:
        asyncio.run(worker.run_with_reconnect())
    except KeyboardInterrupt:
        print('\nStopped.')


if __name__ == '__main__':
    main()
