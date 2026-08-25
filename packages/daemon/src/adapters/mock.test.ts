import { describe, expect, it } from 'vitest';
import { runAdapterContractTests, type AdapterHarness } from './contract-suite.js';
import { MockAdapter } from './mock.js';

async function factory(): Promise<AdapterHarness> {
  return {
    adapter: new MockAdapter(),
    makeConfig: (sessionId) => ({
      sessionId,
      cwd: '/work',
      env: {},
      approvalPolicy: 'mediate',
    }),
  };
}

runAdapterContractTests('mock', factory);

describe('MockAdapter specifics', () => {
  it('restores pending permissions on resume (FR-1.5)', async () => {
    const pending = {
      requestId: 'p-1',
      kind: 'shell' as const,
      summary: '복원 대상',
      options: [{ optionId: 'allow', label: '허용', kind: 'allow_once' as const }],
    };
    const adapter = new MockAdapter({ pendingOnResume: [pending] });
    const session = await adapter.resumeSession(
      { harness: 'mock', nativeHandle: 'mock-native-s1' },
      { sessionId: 's1', cwd: '/w', env: {}, approvalPolicy: 'mediate' },
    );
    expect(await session.getPendingPermissions()).toEqual([pending]);
  });
});
