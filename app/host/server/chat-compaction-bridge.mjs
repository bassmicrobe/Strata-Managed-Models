import { createChatCompactor } from './chat-compaction.mjs';
import { FIT_TEXT } from './agent/context-fit.mjs';

/** Attach persistent plain-chat compaction to the existing completion transports. */
export function createChatPreparation(options) {
  const compact = createChatCompactor(options);
  return function prepareChat({ chatId, model = {}, signal, onFrame = () => {} }) {
    return async (payload, transport) => {
      const target = { ...transport, ...model };
      if (!(target.contextMax > 0)) return payload;
      const result = await compact({ chatId, model: target, payload, signal,
        force: transport.force === true,
        onProgress: progress => {
          if (progress.phase === 'compacting') onFrame({ type: 'status', phase: 'compacting', code: 'compacting',
            text: FIT_TEXT.summarizing, key: FIT_TEXT.summarizing, values: [] });
          if (progress.phase === 'compacted') {
            onFrame({ type: 'compaction', ...progress, contextMax: target.contextMax });
            onFrame({ type: 'context', contextTokens: progress.afterTokens, contextMax: target.contextMax });
          }
        },
      });
      return result.payload;
    };
  };
}
