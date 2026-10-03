/** 成本核算与「换纸试算」 */
import { pack, type PackGroup, type PackOptions } from './packer'
import { round } from './units'
import type { CostReport, PackResult, Paper } from './types'

export function computeCost(paper: Paper, result: PackResult): CostReport {
  const sheets = result.sheets.length
  const totalPhotoCount = result.stats.totalPhotos
  const totalCents = sheets * paper.priceCents
  const perPhotoCents = totalPhotoCount > 0 ? totalCents / totalPhotoCount : 0
  const usedArea = result.sheets.reduce((acc, s) => acc + s.usedAreaMm2, 0)
  const totalSheetArea = sheets * paper.wMm * paper.hMm
  const wasteRate = totalSheetArea > 0 ? 1 - usedArea / totalSheetArea : 0
  // 不排样：每张照片单独用一整张相纸
  const naiveTotalCents = totalPhotoCount * paper.priceCents
  const naiveArea = totalPhotoCount * paper.wMm * paper.hMm
  const naiveWasteRate = naiveArea > 0 ? 1 - usedArea / naiveArea : 0
  return {
    paperName: paper.name,
    sheets,
    totalCents,
    perPhotoCents: round(perPhotoCents, 2),
    totalPhotoCount,
    wasteRate,
    naiveWasteRate,
    naiveTotalCents,
    savedCents: naiveTotalCents - totalCents,
  }
}

/** 换纸试算排序方式：省纸优先 / 省时优先 / 自定义权重 */
export type CompareSortMode = 'savePaper' | 'saveTime' | 'custom'

/** 自定义权重（各项 ≥0，全部归一化后加权，分低者优先） */
export interface CompareWeights {
  cost: number
  sheets: number
  cuts: number
  utilization: number
}

export const DEFAULT_COMPARE_WEIGHTS: CompareWeights = {
  cost: 1,
  sheets: 1,
  cuts: 1,
  utilization: 1,
}

export interface PaperCompare {
  paper: Paper
  /** 当前正在使用的相纸（也列入候选表作基准） */
  isCurrent: boolean
  ok: boolean
  sheets: number
  avgUtilization: number
  totalCents: number
  perPhotoCents: number
  /** 预计刀数（共边合并后） */
  cutCount: number
  /** 耗纸面积 mm²：单张 = 张数×纸面积；卷筒 = 预估用料长度×卷宽 */
  consumedAreaMm2: number
  /** 卷筒：预估用掉的长度 / 米数 */
  usedLengthMm?: number
  usedMeters?: number
  /** 摆不下等原因（不给出空数行） */
  error?: string
}

/**
 * 换纸试算：全部候选相纸（含卷筒、自定义与当前在用的那张）都试算一遍。
 * 摆不下的纸保留在结果里并给出原因；排序交给 sortCompares。
 */
export function comparePapers(
  groups: PackGroup[],
  opts: Omit<PackOptions, 'paperW' | 'paperH' | 'marginMm'>,
  papers: Paper[],
  currentPaperId: string,
): PaperCompare[] {
  const out: PaperCompare[] = []
  for (const p of papers) {
    const isCurrent = p.id === currentPaperId
    const r = pack(groups, { ...opts, paperW: p.wMm, paperH: p.hMm, marginMm: p.marginMm })
    if (r.error) {
      out.push({
        paper: p,
        isCurrent,
        ok: false,
        sheets: 0,
        avgUtilization: 0,
        totalCents: 0,
        perPhotoCents: 0,
        cutCount: 0,
        consumedAreaMm2: Number.POSITIVE_INFINITY,
        error: r.error,
      })
      continue
    }
    const result = r.result
    const cutCount = result.sheets.reduce((acc, s) => acc + s.cutSteps.length, 0)
    const totalPhotos = result.stats.totalPhotos
    if (p.kind === 'roll') {
      // 卷筒：按「预估用料长度」折算米数、利用率与成本（而不是按整卷长度）
      const usedLengthMm = result.sheets.reduce((acc, s) => {
        const maxBottom = s.placements.reduce((b, pl) => Math.max(b, pl.y + pl.h), 0)
        return acc + Math.ceil(maxBottom + p.marginMm + opts.safeEdgeMm)
      }, 0)
      const usedArea = result.sheets.reduce((acc, s) => acc + s.usedAreaMm2, 0)
      const consumedAreaMm2 = usedLengthMm * p.wMm
      const totalCents = Math.round((p.priceCents * usedLengthMm) / p.hMm)
      out.push({
        paper: p,
        isCurrent,
        ok: true,
        sheets: result.sheets.length,
        avgUtilization: consumedAreaMm2 > 0 ? usedArea / consumedAreaMm2 : 0,
        totalCents,
        perPhotoCents: totalPhotos > 0 ? round(totalCents / totalPhotos, 2) : 0,
        cutCount,
        consumedAreaMm2,
        usedLengthMm,
        usedMeters: round(usedLengthMm / 1000, 3),
      })
    } else {
      const totalCents = result.sheets.length * p.priceCents
      out.push({
        paper: p,
        isCurrent,
        ok: true,
        sheets: result.sheets.length,
        avgUtilization: result.stats.avgUtilization,
        totalCents,
        perPhotoCents: totalPhotos > 0 ? round(totalCents / totalPhotos, 2) : 0,
        cutCount,
        consumedAreaMm2: result.sheets.length * p.wMm * p.hMm,
      })
    }
  }
  return out
}

/** 试算结果排序；摆不下的纸永远沉底（原因已在行内给出） */
export function sortCompares(
  list: PaperCompare[],
  mode: CompareSortMode,
  weights: CompareWeights = DEFAULT_COMPARE_WEIGHTS,
): PaperCompare[] {
  const ok = list.filter((c) => !c.error)
  const bad = list.filter((c) => c.error)
  const byCost = (a: PaperCompare, b: PaperCompare) =>
    a.totalCents - b.totalCents || b.avgUtilization - a.avgUtilization
  let sorted: PaperCompare[]
  if (mode === 'savePaper') {
    // 省纸优先：耗纸最少 → 刀数少 → 总价低
    sorted = ok.sort(
      (a, b) => a.consumedAreaMm2 - b.consumedAreaMm2 || a.cutCount - b.cutCount || byCost(a, b),
    )
  } else if (mode === 'saveTime') {
    // 省时优先：刀数最少 → 张数少 → 总价低
    sorted = ok.sort((a, b) => a.cutCount - b.cutCount || a.sheets - b.sheets || byCost(a, b))
  } else {
    // 自定义权重：各项指标按候选中的最大值归一化后加权，分低者优先
    const max = (f: (c: PaperCompare) => number) => Math.max(0, ...ok.map(f))
    const maxCost = max((c) => c.totalCents)
    const maxSheets = max((c) => c.sheets)
    const maxCuts = max((c) => c.cutCount)
    const maxWaste = max((c) => 1 - c.avgUtilization)
    const score = (c: PaperCompare) =>
      (maxCost > 0 ? (weights.cost * c.totalCents) / maxCost : 0) +
      (maxSheets > 0 ? (weights.sheets * c.sheets) / maxSheets : 0) +
      (maxCuts > 0 ? (weights.cuts * c.cutCount) / maxCuts : 0) +
      (maxWaste > 0 ? (weights.utilization * (1 - c.avgUtilization)) / maxWaste : 0)
    sorted = ok.sort((a, b) => score(a) - score(b) || byCost(a, b))
  }
  return [...sorted, ...bad]
}
