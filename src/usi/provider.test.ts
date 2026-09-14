import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderFallback, parseProviderLine } from './parse.ts';
import { cudaAdvice, cudaFallbackError, type ProviderReport } from './provider.ts';

test('provider: Libra が isready で出す行', () => {
  assert.deepEqual(parseProviderLine('info string model libra-iter2455.onnx onnxruntime 1.30.0 provider dml'), {
    model: 'libra-iter2455.onnx', onnxruntime: '1.30.0', provider: 'dml',
  });
  assert.equal(parseProviderLine('info string model a.onnx onnxruntime 1.30.0 provider cuda\r')?.provider, 'cuda');
  // ファイル名に空白があっても onnxruntime の前までを名前として読む
  assert.equal(parseProviderLine('info string model my model.onnx onnxruntime 1.30.0 provider cpu')?.model, 'my model.onnx');
});

test('provider: 違う行は拾わない', () => {
  assert.equal(parseProviderLine('info string phase fuseki ply 12'), null);
  assert.equal(parseProviderLine('info string model a.onnx onnxruntime 1.30.0 provider tensorrt'), null);
  assert.equal(parseProviderLine('info depth 3 score cp 10 pv 7g7f'), null);
  // fallback の行を provider の行と取り違えない
  assert.equal(parseProviderLine('info string provider fallback cuda: x'), null);
});

test('provider fallback: エラー文をそのまま残す', () => {
  const line = 'info string provider fallback cuda: D:\\a\\_work\\1\\s\\onnxruntime\\core\\session\\provider_bridge_ort.cc:1778 onnxruntime::TryGetProviderInfo_CUDA [ONNXRuntimeError] : 1 : FAIL : LoadLibrary failed for cudnn64_9.dll with error 2';
  const f = parseProviderFallback(line);
  assert.equal(f?.from, 'cuda');
  assert.match(f?.error ?? '', /cudnn64_9\.dll with error 2$/);
  assert.equal(parseProviderFallback('info string model a.onnx onnxruntime 1.30.0 provider cpu'), null);
});

const report = (provider: ProviderReport['provider'], fallbacks: ProviderReport['fallbacks'] = []): ProviderReport => ({ provider, fallbacks });

test('案内: NVIDIA の GPU で DirectML か CPU なら切り替えを勧める', () => {
  assert.equal(cudaAdvice(report('dml'), true), 'switch');
  assert.equal(cudaAdvice(report('cpu'), true), 'switch');
  assert.equal(cudaAdvice(report('dml'), false), null);
  assert.equal(cudaAdvice(report('cpu'), false), null);
});

test('案内: CUDA で動いていれば出さない', () => {
  assert.equal(cudaAdvice(report('cuda'), true), null);
});

test('案内: CUDA を試して落ちたら、足りない DLL の案内を出す', () => {
  const r = report('cpu', [{ from: 'cuda', error: 'LoadLibrary failed for cudnn64_9.dll with error 2' }]);
  assert.equal(cudaAdvice(r, true), 'fallback');
  // NVIDIA の GPU を見つけられなかった PC でも出す（本人が切り替えようとしている）
  assert.equal(cudaAdvice(r, false), 'fallback');
  assert.equal(cudaFallbackError(r), 'LoadLibrary failed for cudnn64_9.dll with error 2');
  // CUDA 以外の fallback は切り替えの失敗ではない
  assert.equal(cudaAdvice(report('cpu', [{ from: 'dml', error: 'x' }]), true), 'switch');
});
