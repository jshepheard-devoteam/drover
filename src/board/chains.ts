/**
 * Pure graph logic run once, at `board load` time: group tickets into
 * weakly-connected components ("chains" — the scheduler's unit of work, see
 * board/run.ts) and give each a deterministic topological order.
 *
 * Deps never cross a chain boundary by construction: if A depends on B, A
 * and B are in the same weakly-connected component. So every dep a ticket
 * lists is guaranteed to resolve within its own chain.
 */

export interface ChainInput {
  readonly id: string;
  readonly deps: readonly string[];
}

export interface ChainAssignment {
  readonly chainId: string;
  readonly seq: number;
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression.
    let cur = id;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Assigns each ticket a `chainId` (deterministic: the lexicographically
 * smallest ticket id in its weakly-connected component, so re-running
 * `board load` on the same input reproduces the same chain ids) and a `seq`
 * giving its topological order within that chain.
 *
 * Throws on an unknown dep id or a dependency cycle — both are load-time
 * boundary errors, not runtime states the scheduler should have to handle.
 */
export const computeChains = (
  tickets: readonly ChainInput[],
): Map<string, ChainAssignment> => {
  const ids = new Set(tickets.map((t) => t.id));
  for (const t of tickets) {
    for (const dep of t.deps) {
      if (!ids.has(dep)) {
        throw new Error(`Ticket "${t.id}" depends on unknown ticket "${dep}"`);
      }
    }
  }

  const uf = new UnionFind();
  // Add every id before unioning any — a dep can reference a ticket that
  // appears later in `tickets`, and union() requires both sides already
  // tracked.
  for (const t of tickets) uf.add(t.id);
  for (const t of tickets) {
    for (const dep of t.deps) uf.union(t.id, dep);
  }

  const componentMembers = new Map<string, string[]>();
  for (const t of tickets) {
    const root = uf.find(t.id);
    const members = componentMembers.get(root) ?? [];
    members.push(t.id);
    componentMembers.set(root, members);
  }

  const byId = new Map(tickets.map((t) => [t.id, t] as const));
  const result = new Map<string, ChainAssignment>();

  for (const members of componentMembers.values()) {
    const chainId = [...members].sort()[0]!;
    const order = topologicalOrder(members, byId, chainId);
    order.forEach((id, seq) => result.set(id, { chainId, seq }));
  }

  return result;
};

const topologicalOrder = (
  members: readonly string[],
  byId: ReadonlyMap<string, ChainInput>,
  chainId: string,
): string[] => {
  const memberSet = new Set(members);
  const inDegree = new Map<string, number>(members.map((id) => [id, 0]));
  const dependents = new Map<string, string[]>(
    members.map((id) => [id, []] as const),
  );

  for (const id of members) {
    const deps = byId.get(id)!.deps.filter((d) => memberSet.has(d));
    inDegree.set(id, deps.length);
    for (const dep of deps) dependents.get(dep)!.push(id);
  }

  // Deterministic queue order (sorted ids) so re-running load on unchanged
  // input reproduces the same seq numbers.
  const queue = [...members].filter((id) => inDegree.get(id) === 0).sort();
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    const next = [...dependents.get(id)!].sort();
    for (const dep of next) {
      const remaining = inDegree.get(dep)! - 1;
      inDegree.set(dep, remaining);
      if (remaining === 0) queue.push(dep);
    }
    queue.sort();
  }

  if (order.length !== members.length) {
    const stuck = members.filter((id) => !order.includes(id)).sort();
    throw new Error(
      `Dependency cycle detected in chain "${chainId}": ${stuck.join(", ")}`,
    );
  }

  return order;
};
