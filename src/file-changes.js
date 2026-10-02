/** 会话中的编辑记录。只记录工具声明的片段，不把片段冒充完整文件。 */
export function createFileChanges() {
  return { rev: 0, files: new Map(), latestPath: undefined }
}

export function recordFileChange(view, row, presentation, status) {
  if (presentation?.card !== 'diff' || !Array.isArray(presentation.diffs)) return
  const changes = view.fileChanges ??= createFileChanges()
  row.fileOrder ??= view.rows.indexOf(row)
  const grouped = new Map()
  for (const diff of presentation.diffs) {
    if (typeof diff?.path !== 'string' || !diff.path) continue
    if (!grouped.has(diff.path)) grouped.set(diff.path, [])
    grouped.get(diff.path).push({ ...diff })
  }
  for (const [path, diffs] of grouped) {
    const previous = changes.files.get(path)
    // 并行调用乱序结束时，较早调用的结果不能覆盖较新的编辑。
    if (previous && previous.callId !== row.callId && previous.order > row.fileOrder) continue
    changes.files.set(path, { path, diffs, status, callId: row.callId, order: row.fileOrder,
      revision: (previous?.revision ?? 0) + 1 })
    if (!previous || previous.callId !== row.callId) changes.latestPath = path
    changes.rev++
  }
}
