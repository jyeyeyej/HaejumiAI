export function createRenderCoordinator({ repositories, renderer }) {
  const controllers = new Map();

  return {
    enqueue(jobId) {
      setImmediate(() => run(jobId));
    },
    resumeQueued() {
      for (const jobId of repositories.recoverInterruptedRenders()) this.enqueue(jobId);
    },
    async cancel(ownerId, jobId) {
      const job = repositories.cancelRenderJob(ownerId, jobId);
      controllers.get(jobId)?.abort();
      return job;
    },
  };

  async function run(jobId) {
    let context;
    try { context = repositories.claimRenderJob(jobId); }
    catch (error) { repositories.failRenderJob(jobId, error?.code || 'RENDER_FAILED'); return; }
    if (!context) return;
    const controller = new AbortController();
    controllers.set(jobId, controller);
    try {
      const result = await renderer.render({
        mediaItems: context.mediaItems,
        projectId: context.project.project_id,
        version: context.task.current_version,
        targetSeconds: context.project.target_seconds,
        scenes: context.project.creator_plan?.scenes ?? null,
        framing: context.project.framing ?? 'fit_pad',
        focalX: context.project.focal_x ?? 0.5,
        focalY: context.project.focal_y ?? 0.5,
        captions: context.project.composition?.captions_enabled ? context.project.caption_draft ?? [] : [],
        composition: context.project.composition ?? null,
        musicPath: context.musicPath,
        reuseVideo: context.reuseVideo,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) repositories.finishRenderJob(jobId, result);
    } catch (error) {
      if (!controller.signal.aborted) repositories.failRenderJob(jobId, error?.code || 'RENDER_FAILED', {
        failureStage: error?.failureStage, exitCode: error?.exitCode, diagnosticCode: error?.diagnosticCode });
    } finally {
      controllers.delete(jobId);
    }
  }
}
