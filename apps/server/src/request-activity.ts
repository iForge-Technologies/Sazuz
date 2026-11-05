import type { FastifyRequest } from 'fastify';

// A raw response can outlive its handler; a disconnected handler can outlive its
// response. Both must finish before maintenance may enter.
type Activity = {
  complete: () => Promise<void>;
  handlerStarted: boolean;
  handlerSettled: boolean;
  responseEnded: boolean;
};
const completions = new WeakMap<FastifyRequest, Activity>();

export function bindRequestActivity(request: FastifyRequest, complete: () => Promise<void>) {
  completions.set(request, {
    complete,
    handlerStarted: false,
    handlerSettled: false,
    responseEnded: false,
  });
}

export async function releaseRequestActivity(request: FastifyRequest) {
  const activity = completions.get(request);
  completions.delete(request);
  await activity?.complete();
}

export function startRequestHandler(request: FastifyRequest) {
  const activity = completions.get(request);
  if (activity) activity.handlerStarted = true;
}

export async function settleRequestHandler(request: FastifyRequest, responseEnded: boolean) {
  const activity = completions.get(request);
  if (!activity) return;
  activity.handlerSettled = true;
  activity.responseEnded ||= responseEnded;
  if (activity.responseEnded) await releaseRequestActivity(request);
}

export async function endRequestResponse(request: FastifyRequest, allowBeforeHandler = false) {
  const activity = completions.get(request);
  if (!activity) return;
  activity.responseEnded = true;
  if (activity.handlerSettled || (allowBeforeHandler && !activity.handlerStarted))
    await releaseRequestActivity(request);
}
