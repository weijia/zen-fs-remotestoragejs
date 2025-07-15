/**
 * Basic usage example for zen-fs-remotestoragejs
 */

import { RemoteStorageFileSystem, RemoteStorageConfig } from '../src/index.js';
import open from 'open';
import express from 'express';
import { createServer } from 'http';

// Node.js 方式打开网页授权并获取 OAuth token
async function getTokenViaOAuth(authUrl: string, clientId: string, redirectUri: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const app = express();
    let server;
    app.get('/callback', async (req, res) => {
      // 返回一个页面来处理 fragment 中的 access_token
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Authorization Complete</title>
        </head>
        <body>
          <h1>Authorization successful!</h1>
          <p>You can close this window.</p>
          <script>
            // 从 URL fragment 中提取 access_token
            const hash = window.location.hash.substring(1);
            const params = new URLSearchParams(hash);
            const accessToken = params.get('access_token');
            
            if (accessToken) {
              // 发送 token 到服务器
              fetch('/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ access_token: accessToken })
              });
            }
          </script>
        </body>
        </html>
      `);
    });

    app.post('/token', express.json(), (req, res) => {
      const { access_token } = req.body;
      if (!access_token) {
        res.status(400).send('No access_token received');
        reject(new Error('No access_token received'));
        server.close();
        return;
      }
      res.send('Token received');
      server.close();
      resolve(access_token);
    });
    server = createServer(app);
    server.listen(8080, () => {
      // 打开授权页面 - 使用 Implicit Grant 流程
      const scope = '*:rw'; // RemoteStorage scope for read/write access to all modules
      open(`${authUrl}?response_type=token&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`);
      console.log('请在浏览器完成授权...');
    });
  });
}

async function basicExample() {
  // OAuth2 授权参数（请替换为你的实际参数）
  const authUrl = 'https://5apps.com/rs/oauth/weijia';
  // const tokenUrl = 'https://storage.5apps.com/oauth/token';
  const clientId = 'http://localhost:8080/callback';
  const redirectUri = 'http://localhost:8080/callback';
  let token: string;
  // token = '';
  if (!token) {
      try {
        token = await getTokenViaOAuth(authUrl, clientId, redirectUri);
        console.log('Fetched token:', token);
      } catch (err) {
        console.error('Token fetch failed:', err);
      return;
    }
  }

  // Configure RemoteStorage connection
  const config: RemoteStorageConfig = {
    href: 'https://storage.5apps.com/weijia',  // Your RemoteStorage endpoint
    token,  // OAuth bearer token
    basePath: '',  // Base path for files
    timeout: 30000,
    headers: {
      'X-Custom-Header': 'value',
    },
  };

  try {
    // Create filesystem instance
    console.log('Creating RemoteStorage filesystem...');
    const fs = new RemoteStorageFileSystem(config);

    console.log('Testing basic file operations...');

    // Write a file
    await fs.writeFile('/tests/hello.txt', 'Hello, RemoteStorage with direct HTTP!');
    console.log('File written successfully');

    // Read the file
    const content = await fs.readFile('/tests/hello.txt');
    console.log('File content:', new TextDecoder().decode(content));

    // Check file stats
    const stats = await fs.stat('/tests/hello.txt');
    console.log('File stats:', {
      size: stats.size,
      mode: stats.mode.toString(8),
      mtime: new Date(stats.mtimeMs),
    });

    // Create a directory
    await fs.mkdir('/tests/subfolder', { uid: 0, gid: 0, mode: 0o755 });
    console.log('Directory created');

    // List directory contents
    const files = await fs.readdir('/tests');
    console.log('Directory contents:', files);

    // Write a file in the subdirectory
    await fs.writeFile('/tests/subfolder/nested.txt', 'Nested file content');
    console.log('Nested file written');

    // List subdirectory contents
    const subFiles = await fs.readdir('/tests/subfolder');
    console.log('Subdirectory contents:', subFiles);

    // Copy operation (rename)
    await fs.rename('/tests/hello.txt', '/tests/hello-renamed.txt');
    console.log('File renamed');

    // Verify the rename
    const exists = await fs.exists('/tests/hello-renamed.txt');
    console.log('Renamed file exists:', exists);

    // Write binary data
    const binaryData = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    await fs.writeFile('/tests/binary.bin', binaryData);
    console.log('Binary file written');

    // Read binary data
    const binaryContent = await fs.readFile('/tests/binary.bin');
    console.log('Binary file content:', Array.from(binaryContent));

    // Clean up
    await fs.unlink('/tests/hello-renamed.txt');
    await fs.unlink('/tests/binary.bin');
    await fs.unlink('/tests/subfolder/nested.txt');
    await fs.rmdir('/tests/subfolder');
    console.log('Cleanup completed');

    // Disconnect (not needed for HTTP implementation but good practice)
    await fs.disconnect();
    console.log('Disconnected from RemoteStorage');

  } catch (error) {
    console.error('Error:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
      console.error('Error stack:', error.stack);
    }
  }
}

console.log("Starting RemoteStorage basic usage example...", import.meta.url, `file://${process.argv[1]}`);
// Run the example
function isMainModule() {
  // 兼容 Windows 路径
  const metaUrl = import.meta.url.replace('file:///', 'file://').replace(/\\/g, '/');
  const argvUrl = `file://${process.argv[1].replace(/\\/g, '/')}`;
  return metaUrl === argvUrl;
}

if (isMainModule()) {
  basicExample();
}