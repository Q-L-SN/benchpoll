import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import test from 'node:test';

const config = await readFile(new URL('../ops/nginx/benchpoll.conf', import.meta.url), 'utf8');

test('Nginx releases idle upstream sockets before the application deadline', () => {
    const upstream = config.match(/upstream\s+benchpoll_app\s*\{([^{}]+)\}/)?.[1];
    assert.ok(upstream);
    assert.match(upstream, /keepalive\s+16\s*;/);
    const timeout = upstream.match(/keepalive_timeout\s+(\d+)s\s*;/);
    assert.ok(timeout, 'Upstream idle timeout must be explicit, not inherited');
    const server = https.createServer();
    try {
        const milliseconds = Number(timeout[1]) * 1000;
        assert.ok(milliseconds > 0);
        assert.ok(milliseconds < server.keepAliveTimeout);
        assert.equal(milliseconds, 3000);
    } finally { server.close(); }
});

test('ordinary HTTPS API requests do not pretend to upgrade the protocol', () => {
    assert.match(config, /proxy_pass\s+https:\/\/benchpoll_app\s*;/);
    assert.match(config, /proxy_http_version\s+1\.1\s*;/);
    assert.equal([...config.matchAll(/proxy_set_header\s+Connection\s+""\s*;/g)].length, 1);
    assert.doesNotMatch(config, /proxy_set_header\s+(?:Upgrade|Connection\s+"upgrade")/i);
});

test('proxy repair preserves request deadlines without retrying submitted mutations', () => {
    assert.match(config, /proxy_connect_timeout\s+30s\s*;/);
    assert.match(config, /proxy_send_timeout\s+120s\s*;/);
    assert.match(config, /proxy_read_timeout\s+120s\s*;/);
    assert.doesNotMatch(config, /proxy_next_upstream[^;]*non_idempotent/);
    assert.match(config, /X-Forwarded-For\s+\$remote_addr\s*;/);
    assert.match(config, /include\s+\/etc\/nginx\/snippets\/benchpoll-cloudflare-real-ip\.conf\s*;/);
});
