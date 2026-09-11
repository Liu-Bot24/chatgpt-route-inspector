import type { ModelLabelSource, ResponseModelSource, RouteAssessment, RouteFields, RouteModelSource } from './types';

function normalized(value: string | null): string | null {
  return value?.trim().toLowerCase() || null;
}

export function assessRoute(fields: RouteFields): RouteAssessment {
  const requested = normalized(fields.requestedModel);
  const routeCandidates: Array<{ source: RouteModelSource; model: string | null }> = [
    { source: 'resolved_model_slug', model: normalized(fields.resolvedModelSlug) },
    { source: 'server_ste_metadata.model_slug', model: normalized(fields.serverModelSlug) }
  ];
  const labelCandidates: Array<{ source: ModelLabelSource; model: string | null }> = [
    { source: 'assistant.metadata.model_slug', model: normalized(fields.responseModelSlug) },
    { source: 'assistant[data-message-model-slug]', model: normalized(fields.domModelSlug) }
  ];
  const presentRoutes = routeCandidates.filter((candidate): candidate is { source: RouteModelSource; model: string } => candidate.model !== null);
  const presentLabels = labelCandidates.filter((candidate): candidate is { source: ModelLabelSource; model: string } => candidate.model !== null);
  const explicitRouteSources = presentRoutes.map((candidate) => candidate.source);
  const modelLabelSources = presentLabels.map((candidate) => candidate.source);
  const routeModels = [...new Set(presentRoutes.map((candidate) => candidate.model))];
  const modelLabels = [...new Set(presentLabels.map((candidate) => candidate.model))];
  const modelLabelConflict = modelLabels.length > 1;
  const modelLabel = modelLabelConflict ? null : modelLabels[0] ?? null;
  const reasons: string[] = [];

  if (requested) reasons.push(`请求模型：${requested}`);
  for (const candidate of presentRoutes) reasons.push(`${candidate.source}：${candidate.model}（显式响应路由字段）`);
  for (const candidate of presentLabels) reasons.push(`${candidate.source}：${candidate.model}（模型标签）`);
  if (modelLabelConflict) reasons.push('模型标签字段互相不同');

  const explicitRouteConflict = routeModels.length > 1;
  const explicitRouteModel = explicitRouteConflict ? null : routeModels[0] ?? null;
  // A dedicated display category for these exact routes, not a general exemption for auto models.
  // Keep conflicting server fields and every other route on the existing assessment path.
  const autoRouteModel = presentRoutes.length > 0 ? explicitRouteModel : modelLabel;
  if (autoRouteModel === 'gpt-5-6-auto-thinking' || autoRouteModel === 'gpt-5-5-auto-thinking') {
    return {
      verdict: 'auto_reasoning',
      routeModel: autoRouteModel,
      routeModelSources: presentRoutes.length > 0 ? explicitRouteSources : modelLabelSources,
      modelLabel,
      modelLabelSources,
      modelLabelConflict,
      reasons: [...reasons, `响应路由为 ${autoRouteModel}，标记为自动推理`]
    };
  }
  const routeLabelConflict = Boolean(explicitRouteModel && presentLabels.some((candidate) => candidate.model !== explicitRouteModel));
  if (explicitRouteConflict || routeLabelConflict) {
    const routeModelSources: ResponseModelSource[] = [
      ...explicitRouteSources,
      ...(routeLabelConflict ? modelLabelSources : [])
    ];
    return {
      verdict: 'conflict',
      routeModel: null,
      routeModelSources,
      modelLabel,
      modelLabelSources,
      modelLabelConflict,
      reasons: [...reasons, '响应路由证据字段之间存在不一致']
    };
  }

  const routeModel = explicitRouteModel ?? modelLabel;
  const routeModelSources: ResponseModelSource[] = explicitRouteModel
    ? explicitRouteSources
    : modelLabel
      ? modelLabelSources
      : [];
  if (!routeModel) {
    reasons.push(modelLabelConflict
      ? '模型标签字段互相不同，无法确定响应路由'
      : '响应中没有可用的响应路由字段或模型标签');
    return { verdict: 'unknown', routeModel: null, routeModelSources, modelLabel, modelLabelSources, modelLabelConflict, reasons };
  }

  if (!explicitRouteModel) reasons.push(`未取得显式响应路由字段；使用模型标签 ${routeModel} 作为响应路由`);
  if (!requested) {
    reasons.push('已取得响应路由模型，但当前记录没有对应的请求模型');
    return { verdict: 'unknown', routeModel, routeModelSources, modelLabel, modelLabelSources, modelLabelConflict, reasons };
  }

  const verdict = requested === routeModel ? 'normal' : 'mismatch';
  reasons.push(verdict === 'normal' ? '请求模型与响应路由模型一致' : '请求模型与响应路由模型不一致');
  return { verdict, routeModel, routeModelSources, modelLabel, modelLabelSources, modelLabelConflict, reasons };
}
