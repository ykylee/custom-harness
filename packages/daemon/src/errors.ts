// 데몬 레벨 에러 — RPC 실패 응답(RpcError { code, message, retriable })으로 투영된다.
import type { RpcError } from '@custom-harness/protocol';
import { AdapterError } from './adapters/contract.js';

export type DaemonErrorCode =
  | 'not_found'
  | 'busy'
  | 'session_limit'
  | 'bad_request'
  | 'unsupported'
  | 'unimplemented'
  | 'internal';

export class DaemonError extends Error {
  readonly code: DaemonErrorCode;
  readonly retriable: boolean;

  constructor(code: DaemonErrorCode, message: string, opts: { retriable?: boolean } = {}) {
    super(message);
    this.name = 'DaemonError';
    this.code = code;
    this.retriable = opts.retriable ?? false;
  }
}

export function toRpcError(error: unknown): RpcError {
  if (error instanceof DaemonError) {
    return { code: error.code, message: error.message, retriable: error.retriable };
  }
  if (error instanceof AdapterError) {
    return {
      code: error.kind,
      message: error.message,
      retriable: error.retriable,
      detail: error.nativeDetail,
    };
  }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) };
}
