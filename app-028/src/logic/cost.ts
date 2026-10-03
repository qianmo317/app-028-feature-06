/** 成本核算与「换纸试算」 */
import { pack, type PackGroup, type PackOptions } from './packer'
import { round } from './units'
import type { CostReport, PackResult, Paper, Sheet } from './types'

/** 由排样结果反推纸边留白 + 安全边（排样器从可用区左上角开始放，最小坐标即 inset） */
export function insetOf(sheets: Sheet[]): number {
  let inset = Infinity
  for (const s of sheets) {
    for (const p of s.placements) {
      inset = Math.min(inset, p.x, p.y)
    }
  }
  return Number.isFinite(inset) ? inset : 0
}

/**
 * 一段卷筒纸沿走纸方向（h 方向）实际用掉的长度（mm）：
 * 最远一张照片的底边 + 端部留白，向上取整到 0.1mm。
 */
export function rollSheetUsedMm(sheet: Sheet, paper: Paper): number {
  if (!sheet.placements.length) return 0
  const inset = insetOf([sheet])
  const maxY = sheet.placements.reduce((acc, p) => Math.max(acc, p.y + p.h), 0)
  return round(Math.min(paper.hMm, maxY + inset), 1)
}

/** 卷筒纸按实际消耗长度折算的材料价（分） */
export function rollLengthCents(paper: Paper, usedLengthMm: number): number {
  if (paper.hMm <= 0) return 0
  return round((usedLengthMm / paper.hMm) * paper.priceCents, 2)
}

export function computeCost(paper: Paper, result: PackResult): CostReport {
  const sheets = result.sheets.length
  const totalPhotoCount = result.stats.totalPhotos
  const usedArea = result.sheets.reduce((acc, s) => acc + s.usedAreaMm2, 0)

  let totalCents: number
  let totalSheetArea: number
  let naiveTotalCents: number
  let naiveArea: number
  let usedLengthMm: number | undefined

  if (paper.kind === 'roll') {
    // 卷筒纸按预估消耗的米数计价（不足整卷的部分按长度折算）
    usedLengthMm = round(
      result.sheets.reduce((acc, s) => acc + rollSheetUsedMm(s, paper), 0),
      1,
    )
    totalCents = rollLengthCents(paper, usedLengthMm)
    totalSheetArea = paper.wMm * usedLengthMm
    // 不排样：每张照片单独沿走纸方向占一段（照片走纸方向边长 + 两端留白）
    const inset = insetOf(result.sheets)
    let naiveMm = 0
    for (const s of result.sheets) {
      for (const p of s.placements) naiveMm += p.h + 2 * inset
    }
    naiveMm = round(Math.min(naiveMm, sheets * paper.hMm), 1)
    naiveTotalCents = rollLengthCents(paper, naiveMm)
    naiveArea = paper.wMm * naiveMm
  } else {
    totalCents = sheets * paper.priceCents
    totalSheetArea = sheets * paper.wMm * paper.hMm
    // 不排样：每张照片单独用一整张相纸
    naiveTotalCents = totalPhotoCount * paper.priceCents
    naiveArea = totalPhotoCount * paper.wMm * paper.hMm
  }

  const perPhotoCents = totalPhotoCount > 0 ? totalCents / totalPhotoCount : 0
  const wasteRate = totalSheetArea > 0 ? 1 - usedArea / totalSheetArea : 0
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
    savedCents: round(naiveTotalCents - totalCents, 2),
    usedLengthMm,
  }
}

/** 换纸试算中每种候选纸的关键指标 */
export interface TrialMetrics {
  /** 单张纸：用纸张数；卷筒：走纸段数（每段最长为一卷） */
  sheets: number
  /** 预计刀数（共边合并后） */
  cuts: number
  /** 未合并的刀口数 */
  rawCuts: number
  /** 利用率 = 照片面积 / 实际消耗面积（卷筒按消耗长度算） */
  utilization: number
  /** 照片总面积 mm² */
  usedAreaMm2: number
  /** 实际消耗面积 mm²（卷筒只算走纸用掉的长度） */
  consumedAreaMm2: number
  /** 总价（分）：单张按张数 × 单价；卷筒按消耗长度折算 */
  totalCents: number
  isRoll: boolean
  /** 卷筒预估消耗长度 mm */
  usedLengthMm?: number
  /** 单价：单张=每张贴；卷筒=每米 */
  unitPriceCents: number
}

export function metricsFromResult(paper: Paper, result: PackResult): TrialMetrics {
  const isRoll = paper.kind === 'roll'
  const sheets = result.sheets.length
  const usedAreaMm2 = result.sheets.reduce((acc, s) => acc + s.usedAreaMm2, 0)
  const cuts = result.sheets.reduce((acc, s) => acc + s.cutSteps.length, 0)
  const rawCuts = result.sheets.reduce((acc, s) => acc + s.rawCutCount, 0)

  let usedLengthMm: number | undefined
  let consumedAreaMm2: number
  let totalCents: number
  if (isRoll) {
    usedLengthMm = round(
      result.sheets.reduce((acc, s) => acc + rollSheetUsedMm(s, paper), 0),
      1,
    )
    consumedAreaMm2 = paper.wMm * usedLengthMm
    totalCents = rollLengthCents(paper, usedLengthMm)
  } else {
    consumedAreaMm2 = sheets * paper.wMm * paper.hMm
    totalCents = sheets * paper.priceCents
  }
  return {
    sheets,
    cuts,
    rawCuts,
    utilization: consumedAreaMm2 > 0 ? usedAreaMm2 / consumedAreaMm2 : 0,
    usedAreaMm2: round(usedAreaMm2, 1),
    consumedAreaMm2: round(consumedAreaMm2, 1),
    totalCents: round(totalCents, 2),
    isRoll,
    usedLengthMm,
    unitPriceCents: isRoll ? round((paper.priceCents / paper.hMm) * 1000, 2) : paper.priceCents,
  }
}

export type CompareSortMode = 'paper' | 'time' | 'custom'

/** 自定义排序权重：省钱 / 省纸 / 省时 */
export interface TrialWeights {
  cost: number
  paper: number
  time: number
}

export interface PaperCompare {
  paper: Paper
  isCurrent: boolean
  feasible: boolean
  /** 摆不下 / 可用区非法 等原因（feasible=false 时给出） */
  reason?: string
  m?: TrialMetrics
}

export interface CurrentTrial {
  paper: Paper
  result: PackResult
}

function trialOptions(
  paper: Paper,
  opts: Omit<PackOptions, 'paperW' | 'paperH' | 'marginMm'>,
): PackOptions {
  return {
    ...opts,
    paperW: paper.wMm,
    paperH: paper.hMm,
    marginMm: paper.marginMm,
  }
}

/**
 * 换纸试算：店里所有相纸（含卷筒、自定义、当前正用的纸）都参与；
 * 摆不下的纸不剔除，保留一行并写明原因。
 */
export function comparePapers(
  groups: PackGroup[],
  opts: Omit<PackOptions, 'paperW' | 'paperH' | 'marginMm'>,
  papers: Paper[],
  currentPaperId: string,
  current: CurrentTrial,
): PaperCompare[] {
  return papers.map((paper) => {
    const isCurrent = paper.id === currentPaperId
    if (isCurrent) {
      return {
        paper,
        isCurrent: true,
        feasible: true,
        m: metricsFromResult(current.paper, current.result),
      }
    }
    try {
      const r = pack(groups, trialOptions(paper, opts))
      if (r.error) return { paper, isCurrent: false, feasible: false, reason: r.error }
      return { paper, isCurrent: false, feasible: true, m: metricsFromResult(paper, r.result) }
    } catch (e) {
      return {
        paper,
        isCurrent: false,
        feasible: false,
        reason: `试算异常：${e instanceof Error ? e.message : String(e)}`,
      }
    }
  })
}

/** 可行方案的排序比较键 */
function tieBreak(a: PaperCompare, b: PaperCompare): number {
  const ma = a.m!
  const mb = b.m!
  return (
    ma.totalCents - mb.totalCents ||
    ma.consumedAreaMm2 - mb.consumedAreaMm2 ||
    ma.cuts - mb.cuts ||
    a.paper.name.localeCompare(b.paper.name, 'zh')
  )
}

/**
 * 排序：
 *  - paper  省纸优先：利用率高 → 便宜 → 刀少
 *  - time   省时优先：刀少 → 张数/段数少 → 便宜
 *  - custom 自定义权重：把 总价 / 耗材面积 / 刀数 归一化后加权（分数越低越靠前）
 */
export function sortComparisons(
  list: PaperCompare[],
  mode: CompareSortMode,
  weights: TrialWeights,
): PaperCompare[] {
  const feasible = list.filter((c) => c.feasible)
  const infeasible = list
    .filter((c) => !c.feasible)
    .sort((a, b) => a.paper.name.localeCompare(b.paper.name, 'zh'))

  if (mode === 'paper') {
    feasible.sort(
      (a, b) =>
        b.m!.utilization - a.m!.utilization ||
        a.m!.totalCents - b.m!.totalCents ||
        a.m!.cuts - b.m!.cuts ||
        tieBreak(a, b),
    )
    return [...feasible, ...infeasible]
  }

  if (mode === 'time') {
    feasible.sort(
      (a, b) =>
        a.m!.cuts - b.m!.cuts ||
        a.m!.sheets - b.m!.sheets ||
        a.m!.totalCents - b.m!.totalCents ||
        tieBreak(a, b),
    )
    return [...feasible, ...infeasible]
  }

  // 自定义权重：min-max 归一化到 [0,1]（全部相等记 0）
  const norm = (pick: (m: TrialMetrics) => number) => {
    const vals = feasible.map((c) => pick(c.m!))
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const span = max - min
    return (c: PaperCompare) => (span > 0 ? (pick(c.m!) - min) / span : 0)
  }
  const nCost = norm((m) => m.totalCents)
  const nPaper = norm((m) => m.consumedAreaMm2)
  const nTime = norm((m) => m.cuts)
  const wSum = weights.cost + weights.paper + weights.time
  feasible.sort((a, b) => {
    if (wSum <= 0) return tieBreak(a, b)
    const sa =
      (weights.cost * nCost(a) + weights.paper * nPaper(a) + weights.time * nTime(a)) / wSum
    const sb =
      (weights.cost * nCost(b) + weights.paper * nPaper(b) + weights.time * nTime(b)) / wSum
    return sa - sb || tieBreak(a, b)
  })
  return [...feasible, ...infeasible]
}
