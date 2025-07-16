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


// 公共辅助函数
function ensureLeadingSlash(path: string): string {
  return path.startsWith('/') ? path : '/' + path;
}

function logResult(label: string, value: any) {
  console.log(label, value);
}

async function safeUnlink(fs: RemoteStorageFileSystem, path: string) {
  try {
    await fs.unlink(path);
    logResult(`Unlinked: ${path}`, 'OK');
  } catch (e) {
    logResult(`Unlink failed (ignore): ${path}`, e?.message || e);
  }
}

async function safeRmdir(fs: RemoteStorageFileSystem, path: string) {
  try {
    await fs.rmdir(path);
    logResult(`Rmdir: ${path}`, 'OK');
  } catch (e) {
    logResult(`Rmdir failed (ignore): ${path}`, e?.message || e);
  }
}

async function basicExample() {
  // OAuth2 授权参数（请替换为你的实际参数）
  const authUrl = 'https://5apps.com/rs/oauth/weijia';
  const clientId = 'http://localhost:8080/callback';
  const redirectUri = 'http://localhost:8080/callback';
  let token: string = '';
  if (!token) {
    try {
      token = await getTokenViaOAuth(authUrl, clientId, redirectUri);
      logResult('Fetched token:', token);
    } catch (err) {
      logResult('Token fetch failed:', err);
      return;
    }
  }

  // 配置 RemoteStorage 连接
  const config: RemoteStorageConfig = {
    href: 'https://storage.5apps.com/weijia',
    token,
    basePath: '',
    timeout: 30000,
    headers: { 'X-Custom-Header': 'value' },
  };

  try {
    logResult('Creating RemoteStorage filesystem...', '');
    const fs = new RemoteStorageFileSystem(config);

    logResult('Testing basic file operations...', '');

    // 写文件
    await fs.writeFile(ensureLeadingSlash('tests/hello.txt'), 'Hello, RemoteStorage with direct HTTP!');
    logResult('File written successfully', 'tests/hello.txt');

    // 读文件
    const content = await fs.readFile(ensureLeadingSlash('tests/hello.txt'));
    logResult('File content:', new TextDecoder().decode(content));

    // 文件 stat
    const stats = await fs.stat(ensureLeadingSlash('tests/hello.txt'));
    logResult('File stats:', {
      size: stats.size,
      mode: stats.mode.toString(8),
      mtime: new Date(stats.mtimeMs),
    });

    // 创建目录
    await fs.mkdir(ensureLeadingSlash('tests/subfolder'), { uid: 0, gid: 0, mode: 0o755 });
    logResult('Directory created', 'tests/subfolder');

    // 目录列表
    const files = await fs.readdir(ensureLeadingSlash('tests'));
    logResult('Directory contents:', files);

    // 子目录写文件
    await fs.writeFile(ensureLeadingSlash('tests/subfolder/nested.txt'), 'Nested file content');
    logResult('Nested file written', 'tests/subfolder/nested.txt');

    // 子目录列表
    const subFiles = await fs.readdir(ensureLeadingSlash('tests/subfolder'));
    logResult('Subdirectory contents:', subFiles);

    // 重命名
    await fs.rename(ensureLeadingSlash('tests/hello.txt'), ensureLeadingSlash('tests/hello-renamed.txt'));
    logResult('File renamed', 'tests/hello.txt -> tests/hello-renamed.txt');

    // 校验重命名
    const exists = await fs.exists(ensureLeadingSlash('tests/hello-renamed.txt'));
    logResult('Renamed file exists:', exists);

    // 写二进制
    const binaryData = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    await fs.writeFile(ensureLeadingSlash('tests/binary.bin'), binaryData);
    logResult('Binary file written', 'tests/binary.bin');

    // 读二进制
    const binaryContent = await fs.readFile(ensureLeadingSlash('tests/binary.bin'));
    logResult('Binary file content:', Array.from(binaryContent));

    // 清理
    await safeUnlink(fs, ensureLeadingSlash('tests/hello-renamed.txt'));
    await safeUnlink(fs, ensureLeadingSlash('tests/binary.bin'));
    await safeUnlink(fs, ensureLeadingSlash('tests/subfolder/nested.txt'));
    await safeRmdir(fs, ensureLeadingSlash('tests/subfolder'));
    logResult('Cleanup completed', '');

    // 断开连接
    await fs.disconnect();
    logResult('Disconnected from RemoteStorage', '');

  } catch (error) {
    logResult('Error:', error);
    if (error instanceof Error) {
      logResult('Error details:', error.message);
      logResult('Error stack:', error.stack);
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