/**
 * DAG Focus session：焦点相关状态的唯一所有者。
 *
 * 语义分层（勿混写）：
 * - **传播焦点** `userFocusId`：用户确立，驱动 ↯；`update`/步进选中不得覆盖。
 * - **步进选中** `selectedId`：描边 / ▶ 步进；可与传播焦点并存（仅 selected 变）。
 * - **悬停预览** `hoveredId`：无选中时参与归因预览（行/目标→上游；非行源→下游）。
 * - **matrix 检查** `matrixLockedTarget` / `matrixHoverTarget`：仅右侧自有交互写入；绘制时原生优先。
 * - **布局多选** `layoutSelectedIds`：与焦点互清，仅多节点拖拽。
 *
 * 点击确立/取消（text 与 matrix 统一）：清悬停；指针离开目标再进入才恢复预览。
 *
 * 所有权（勿混写）：
 * - 左侧自有交互 → text 走 native；matrix 仅在「右侧无 lock/hover」时接受左侧投影。
 * - 右侧自有交互 → matrix 走原生 row/col/cell（不因 Show downstream 升级为 rowAndCol）；
 *   text 仅在「左侧无 committed 焦点」时接受右侧轴语义覆盖。
 *
 * 左侧→右侧投影（Causal Flow 同）：
 * - 行/目标 ↔ 上游（蓝）；列/源 ↔ 下游（红）；格 ↔ 单边箭头；
 * - 左侧焦点 + downstream 开 → matrix `rowAndCol`（蓝行+红列）。
 *
 * 副作用（停播放 / 重绘）由调用方执行；本模块在会改 `userFocusId` 的路径上回调 `onUserFocusChange`。
 */

export type MatrixInteractionTarget =
    | { type: 'row'; id: string }
    | { type: 'col'; id: string }
    /** 同一节点：蓝行（上游/归因）+ 红列（下游）同时高亮；对应左侧焦点且开启 downstream。 */
    | { type: 'rowAndCol'; id: string }
    | { type: 'cell'; srcId: string; tgtId: string };

export type DagFocusApplyResult = {
    /** 调用方应 `stopPlayback`（与历史行为对齐的路径）。 */
    stopPlayback: boolean;
};

export type CreateDagFocusSessionOptions = {
    onUserFocusChange?: (focusId: string | null) => void;
};

export type DagFocusSession = {
    getUserFocusId(): string | null;
    getSelectedId(): string | null;
    getHoveredId(): string | null;
    getMatrixHoverTarget(): MatrixInteractionTarget | null;
    getMatrixLockedTarget(): MatrixInteractionTarget | null;
    getLayoutSelectedIds(): ReadonlySet<string>;

    /** 归因预览焦点：传播/选中优先；仅无选中时用悬停（多选虚线态忽略悬停）。 */
    effectiveFocusId(layoutSelectHoverActive: boolean): string | null;
    /**
     * 实线焦点框节点：非多选虚线态下悬停优先，否则传播/选中。
     * @param nodeExists 图中是否仍有该节点（悬停/焦点校验）。
     */
    solidFrameFocusId(
        layoutSelectHoverActive: boolean,
        nodeExists: (id: string) => boolean,
    ): string | null;

    /**
     * 已确立的 matrix 行焦点（点击 / userFocus / ▶ selected / 行 lock）。
     * `recursiveAttributionEnabled === false` 时恒为 null。
     */
    matrixCommittedRowFocusId(
        recursiveAttributionEnabled: boolean,
        isMatrixRowId: (id: string) => boolean,
    ): string | null;
    /** Self 行：已确立行焦点；否则悬停行预览。 */
    matrixRowFocusId(
        recursiveAttributionEnabled: boolean,
        isMatrixRowId: (id: string) => boolean,
    ): string | null;
    /** matrix 实线悬停对应的「被读份额」节点（仅行/列）。 */
    matrixShareSourceId(): string | null;
    /** ▶ selected 若在行轴上 → row target。 */
    matrixSelectedRowTarget(isMatrixRowId: (id: string) => boolean): MatrixInteractionTarget | null;
    /**
     * matrix 静态归因目标：
     * 1) 右侧自有 lock/hover（原生）；
     * 2) 否则左侧焦点/悬停投影（`showDownstreamInfluence` 时可 `rowAndCol`）。
     * ▶ 播放中优先 selected 行。
     */
    matrixStaticHighlightTarget(
        dagPlaybackPlaying: boolean,
        isMatrixRowId: (id: string) => boolean,
        showDownstreamInfluence: boolean,
    ): MatrixInteractionTarget | null;

    /** 节点图单击：切换传播焦点（与 selected 同步）。 */
    toggleNodeFocus(id: string): DagFocusApplyResult;
    /** matrix 行单击：同上，并维护行 lock。 */
    toggleMatrixRowFocus(id: string): DagFocusApplyResult;
    /** matrix 列单击：静态 lock；清除传播焦点。 */
    toggleMatrixColLock(id: string): DagFocusApplyResult;
    /** matrix 格单击：静态 lock；清除传播焦点。 */
    toggleMatrixCellLock(srcId: string, tgtId: string): DagFocusApplyResult;
    setMatrixHover(target: MatrixInteractionTarget | null): void;
    /** 离开时仅当仍指向同一目标才清除 hover。 */
    clearMatrixHoverIf(match: MatrixInteractionTarget): void;

    /** 仅改步进选中（不改 `userFocusId`）。 */
    setSelectedOnly(id: string | null): void;
    /**
     * 同时设传播焦点与选中；`null` 等价 {@link clearAll}。
     * 会清 layout 多选与 matrix hover，并按行轴同步 row lock。
     */
    setUserFocus(
        id: string | null,
        isMatrixRowId: (id: string) => boolean,
    ): DagFocusApplyResult;
    /** 清空选中 / 传播焦点 / matrix 交互 / 布局多选。 */
    clearAll(): DagFocusApplyResult;
    /** 点 matrix 列/格前：清传播焦点与选中（保留 col/cell lock 由后续写入）。 */
    clearPropagationFocus(): DagFocusApplyResult;
    /** 进入布局多选前：清传播焦点与选中（保留 matrix lock）。 */
    clearFocusForLayoutSelection(): DagFocusApplyResult;
    clearLayoutSelectionOnly(): boolean;
    setHovered(id: string | null): void;
    /** Cmd/Ctrl+点：切换多选集中的 id；会先清传播焦点。 */
    toggleLayoutSelected(id: string): DagFocusApplyResult;
    /** 框选结果写入多选集（additive 或替换）；会先清传播焦点。 */
    setLayoutSelectedAfterMarquee(ids: Iterable<string>, additive: boolean): DagFocusApplyResult;
    /** `update` 新 token：清多选、设 selected（不改 userFocus）。 */
    selectGeneratedToken(id: string): DagFocusApplyResult;
    /** 图清空时重置全部焦点态。 */
    reset(): void;
    /**
     * 不再把左侧焦点写成 matrix 行 lock（避免右侧被投影语义占用）。
     * 仅在左侧已无行焦点时清掉残留行 lock。
     */
    syncMatrixRowLockWithUserFocus(isMatrixRowId: (id: string) => boolean): void;
};

function matrixTargetsEqual(a: MatrixInteractionTarget, b: MatrixInteractionTarget): boolean {
    if (a.type !== b.type) return false;
    if (a.type === 'cell' && b.type === 'cell') {
        return a.srcId === b.srcId && a.tgtId === b.tgtId;
    }
    if (a.type !== 'cell' && b.type !== 'cell') return a.id === b.id;
    return false;
}

/** 左侧焦点/悬停 → matrix 轴投影。 */
function projectLeftNodeToMatrixTarget(
    id: string,
    isMatrixRowId: (id: string) => boolean,
    showDownstreamInfluence: boolean,
    /** committed 焦点：无下游且非行 → null；悬停源 token：仍投影为列（下游）。 */
    role: 'committed' | 'hover',
): MatrixInteractionTarget | null {
    const isRow = isMatrixRowId(id);
    if (showDownstreamInfluence) {
        return isRow ? { type: 'rowAndCol', id } : { type: 'col', id };
    }
    if (isRow) return { type: 'row', id };
    return role === 'hover' ? { type: 'col', id } : null;
}

export function createDagFocusSession(options?: CreateDagFocusSessionOptions): DagFocusSession {
    const onUserFocusChange = options?.onUserFocusChange;

    let userFocusId: string | null = null;
    let selectedId: string | null = null;
    let hoveredId: string | null = null;
    let matrixHoverTarget: MatrixInteractionTarget | null = null;
    let matrixLockedTarget: MatrixInteractionTarget | null = null;
    let layoutSelectedIds = new Set<string>();

    function notify(): void {
        onUserFocusChange?.(userFocusId);
    }

    function clearPropagationFocusInner(): DagFocusApplyResult {
        if (userFocusId == null && selectedId == null) {
            return { stopPlayback: false };
        }
        userFocusId = null;
        selectedId = null;
        notify();
        return { stopPlayback: true };
    }

    const session: DagFocusSession = {
        getUserFocusId: () => userFocusId,
        getSelectedId: () => selectedId,
        getHoveredId: () => hoveredId,
        getMatrixHoverTarget: () => matrixHoverTarget,
        getMatrixLockedTarget: () => matrixLockedTarget,
        getLayoutSelectedIds: () => layoutSelectedIds,

        effectiveFocusId(layoutSelectHoverActive) {
            if (layoutSelectHoverActive) return userFocusId ?? selectedId;
            return userFocusId ?? selectedId ?? hoveredId;
        },

        solidFrameFocusId(layoutSelectHoverActive, nodeExists) {
            if (!layoutSelectHoverActive && hoveredId != null && nodeExists(hoveredId)) {
                return hoveredId;
            }
            const id = userFocusId ?? selectedId;
            return id != null && nodeExists(id) ? id : null;
        },

        matrixCommittedRowFocusId(recursiveAttributionEnabled, isMatrixRowId) {
            if (!recursiveAttributionEnabled) return null;
            if (userFocusId != null && isMatrixRowId(userFocusId)) return userFocusId;
            if (selectedId != null && isMatrixRowId(selectedId)) return selectedId;
            if (matrixLockedTarget?.type === 'row') return matrixLockedTarget.id;
            return null;
        },

        matrixRowFocusId(recursiveAttributionEnabled, isMatrixRowId) {
            const committed = session.matrixCommittedRowFocusId(
                recursiveAttributionEnabled,
                isMatrixRowId,
            );
            if (committed != null) return committed;
            if (matrixHoverTarget?.type === 'row') return matrixHoverTarget.id;
            // text 悬停行 token：与 matrix 行悬停同等预览（text-matrix 联动）
            if (hoveredId != null && isMatrixRowId(hoveredId)) return hoveredId;
            return null;
        },

        matrixShareSourceId() {
            const hover = matrixHoverTarget;
            if (hover == null || hover.type === 'cell') return null;
            return hover.id;
        },

        matrixSelectedRowTarget(isMatrixRowId) {
            if (selectedId == null) return null;
            if (!isMatrixRowId(selectedId)) return null;
            return { type: 'row', id: selectedId };
        },

        matrixStaticHighlightTarget(dagPlaybackPlaying, isMatrixRowId, showDownstreamInfluence) {
            const selectedRow = session.matrixSelectedRowTarget(isMatrixRowId);
            if (dagPlaybackPlaying && selectedRow != null) return selectedRow;
            // 右侧自有：原生 row/col/cell（不因 downstream 升级为 rowAndCol）
            if (matrixLockedTarget != null) return matrixLockedTarget;
            if (matrixHoverTarget != null) return matrixHoverTarget;
            // 仅此时：左侧 → 右侧投影
            const committedId = userFocusId ?? selectedId;
            if (committedId != null) {
                return projectLeftNodeToMatrixTarget(
                    committedId,
                    isMatrixRowId,
                    showDownstreamInfluence,
                    'committed',
                );
            }
            if (hoveredId == null) return null;
            return projectLeftNodeToMatrixTarget(
                hoveredId,
                isMatrixRowId,
                showDownstreamInfluence,
                'hover',
            );
        },

        toggleNodeFocus(id) {
            layoutSelectedIds = new Set();
            const next = userFocusId === id ? null : id;
            userFocusId = next;
            selectedId = next;
            // 左侧接管或清空：放下右侧 lock，让 matrix 走投影 / 空闲
            matrixLockedTarget = null;
            matrixHoverTarget = null;
            // 与 matrix 一致：点击确立/取消后清悬停，指针离开再进入才恢复预览
            hoveredId = null;
            notify();
            return { stopPlayback: true };
        },

        toggleMatrixRowFocus(id) {
            layoutSelectedIds = new Set();
            const next = userFocusId === id ? null : id;
            userFocusId = next;
            selectedId = next;
            matrixLockedTarget = next != null ? { type: 'row', id: next } : null;
            matrixHoverTarget = null;
            hoveredId = null;
            notify();
            return { stopPlayback: true };
        },

        toggleMatrixColLock(id) {
            const cleared = clearPropagationFocusInner();
            const same = matrixLockedTarget?.type === 'col' && matrixLockedTarget.id === id;
            matrixLockedTarget = same ? null : { type: 'col', id };
            matrixHoverTarget = null;
            hoveredId = null;
            return { stopPlayback: cleared.stopPlayback };
        },

        toggleMatrixCellLock(srcId, tgtId) {
            const cleared = clearPropagationFocusInner();
            const same =
                matrixLockedTarget?.type === 'cell' &&
                matrixLockedTarget.srcId === srcId &&
                matrixLockedTarget.tgtId === tgtId;
            matrixLockedTarget = same ? null : { type: 'cell', srcId, tgtId };
            matrixHoverTarget = null;
            hoveredId = null;
            return { stopPlayback: cleared.stopPlayback };
        },

        setMatrixHover(target) {
            matrixHoverTarget = target;
        },

        clearMatrixHoverIf(match) {
            if (matrixHoverTarget != null && matrixTargetsEqual(matrixHoverTarget, match)) {
                matrixHoverTarget = null;
            }
        },

        setSelectedOnly(id) {
            layoutSelectedIds = new Set();
            selectedId = id;
        },

        setUserFocus(id, _isMatrixRowId) {
            if (id == null) return session.clearAll();
            layoutSelectedIds = new Set();
            userFocusId = id;
            selectedId = id;
            // 左侧写入焦点：不占用 matrix lock，matrix 靠投影显示
            matrixLockedTarget = null;
            matrixHoverTarget = null;
            hoveredId = null;
            notify();
            return { stopPlayback: true };
        },

        clearAll() {
            layoutSelectedIds = new Set();
            selectedId = null;
            userFocusId = null;
            matrixLockedTarget = null;
            matrixHoverTarget = null;
            hoveredId = null;
            notify();
            return { stopPlayback: true };
        },

        clearPropagationFocus: clearPropagationFocusInner,

        clearFocusForLayoutSelection() {
            selectedId = null;
            userFocusId = null;
            hoveredId = null;
            notify();
            return { stopPlayback: true };
        },

        clearLayoutSelectionOnly() {
            if (layoutSelectedIds.size === 0) return false;
            layoutSelectedIds = new Set();
            return true;
        },

        setHovered(id) {
            hoveredId = id;
        },

        toggleLayoutSelected(id) {
            const r = session.clearFocusForLayoutSelection();
            const next = new Set(layoutSelectedIds);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            layoutSelectedIds = next;
            return r;
        },

        setLayoutSelectedAfterMarquee(ids, additive) {
            const r = session.clearFocusForLayoutSelection();
            if (additive) {
                const next = new Set(layoutSelectedIds);
                for (const id of ids) next.add(id);
                layoutSelectedIds = next;
            } else {
                layoutSelectedIds = new Set(ids);
            }
            return r;
        },

        selectGeneratedToken(id) {
            layoutSelectedIds = new Set();
            selectedId = id;
            return { stopPlayback: true };
        },

        reset() {
            selectedId = null;
            userFocusId = null;
            layoutSelectedIds = new Set();
            hoveredId = null;
            matrixHoverTarget = null;
            matrixLockedTarget = null;
            notify();
        },

        syncMatrixRowLockWithUserFocus(isMatrixRowId) {
            // 左侧行焦点不再镜像为 matrix 行 lock（否则右侧会丢失原生态、被投影语义占用）。
            if (userFocusId != null && isMatrixRowId(userFocusId)) return;
            if (matrixLockedTarget?.type === 'row') matrixLockedTarget = null;
        },
    };

    return session;
}
