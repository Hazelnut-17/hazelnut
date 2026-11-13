import { SourceAst, type SourceNode, sourceNode } from "./source-ast.ts";

export interface RowCall {
  readonly verb: string;
  readonly methodOffset: number;
}

function functionSource(
  source: string,
): { ast: SourceAst; prefix: number } | null {
  // An op source can be a function expression or an object method.
  for (const [before, after] of [["(", "\n)"], ["({", "\n})"]] as const) {
    try {
      return {
        ast: new SourceAst(before + source + after),
        prefix: before.length,
      };
    } catch {
      // An unrecognized source slice keeps the existing read/write finding.
    }
  }
  return null;
}

function awaitedResult(ast: SourceAst, call: SourceNode) {
  const init = ast.parent(call);
  if (init?.type !== "AwaitExpression") return null;
  const binding = ast.parent(init);
  const statement = binding && ast.parent(binding);
  if (
    binding?.type !== "VariableDeclarator" || !sourceNode(binding.id) ||
    binding.id.type !== "Identifier" || statement?.kind !== "const"
  ) return null;
  return { init, statement };
}

function updateStatement(
  ast: SourceAst,
  call: SourceNode,
): SourceNode | undefined {
  let parent = ast.parent(call);
  if (parent?.type === "AwaitExpression") parent = ast.parent(parent);
  if (parent?.type === "VariableDeclarator") parent = ast.parent(parent);
  return parent &&
      ["ReturnStatement", "ExpressionStatement", "VariableDeclaration"]
        .includes(parent.type)
    ? parent
    : undefined;
}

function pathOf(ast: SourceAst, node: SourceNode) {
  let root = ast.unwrap(node);
  const fields: string[] = [];
  while (
    root.type === "MemberExpression" && sourceNode(root.property) &&
    sourceNode(root.object)
  ) {
    const property = root.property;
    if (
      root.computed === false && property.type === "Identifier" &&
      typeof property.name === "string"
    ) fields.unshift(property.name);
    else if (
      root.computed === true && property.type === "NumericLiteral" &&
      typeof property.value === "number" &&
      Number.isSafeInteger(property.value) &&
      property.value >= 0
    ) fields.unshift(String(property.value));
    else return null;
    root = ast.unwrap(root.object);
  }
  return root.type === "Identifier" ? { root, fields } : null;
}

function sameReceiver(
  ast: SourceAst,
  first: SourceNode,
  second: SourceNode,
): boolean {
  const a = first.callee, b = second.callee;
  if (
    !sourceNode(a) || !sourceNode(b) || !sourceNode(a.object) ||
    !sourceNode(b.object)
  ) return false;
  const left = pathOf(ast, a.object), right = pathOf(ast, b.object);
  return left !== null && right !== null &&
    left.root.name === right.root.name &&
    left.fields.join(".") === right.fields.join(".") &&
    ast.binding(left.root) === ast.binding(right.root);
}

/** A const alias can carry the ID from the lookup to the lock and update. Record
 * the exact identifier uses that establish that flow, so using the alias in the
 * patch or passing it to a different helper cannot silently broaden the proof. */
function lookupId(
  ast: SourceAst,
  expression: SourceNode,
  result: SourceNode,
  uses: Map<SourceNode, Set<SourceNode>>,
): boolean {
  const path = pathOf(ast, expression);
  if (!path) return false;
  const binding = ast.binding(path.root);
  if (!binding) return false;
  if (binding === result) {
    if (!/^(?:value\.)?(?:\d+\.)?id$/.test(path.fields.join("."))) return false;
  } else {
    if (
      path.fields.length !== 0 ||
      (binding.end ?? Infinity) > (path.root.start ?? -Infinity)
    ) return false;
    if (!uses.has(binding) && !lookupId(ast, binding, result, uses)) {
      return false;
    }
  }
  const refs = uses.get(binding) ?? new Set<SourceNode>();
  refs.add(path.root);
  uses.set(binding, refs);
  return true;
}

function isReference(ast: SourceAst, node: SourceNode): boolean {
  if (node.type !== "Identifier") return false;
  const parent = ast.parent(node);
  if (parent?.type === "VariableDeclarator" && parent.id === node) return false;
  if (
    parent?.computed === false && (
      (parent.type === "MemberExpression" ||
          parent.type === "OptionalMemberExpression") &&
        parent.property === node ||
      parent.type === "ObjectProperty" && parent.key === node
    )
  ) return false;
  return true;
}

/** An early return can test whether the lookup succeeded or found a row. */
function failureGuard(ast: SourceAst, node: SourceNode, binding: SourceNode) {
  const member = ast.parent(node);
  let test = member && ast.parent(member);
  if (
    member?.type !== "MemberExpression" || member.object !== node ||
    member.computed !== false || !sourceNode(member.property) ||
    (member.property.name !== "ok" && member.property.name !== "value") ||
    test?.type !== "UnaryExpression" || test.operator !== "!"
  ) return null;
  let condition = ast.parent(test);
  while (
    condition?.type === "LogicalExpression" && condition.operator === "||"
  ) {
    test = condition;
    condition = ast.parent(test);
  }
  if (
    condition?.type !== "IfStatement" || condition.test !== test ||
    !sourceNode(condition.consequent)
  ) return null;
  let branch = condition.consequent;
  if (
    branch.type === "BlockStatement" && Array.isArray(branch.body) &&
    branch.body.length === 1 && sourceNode(branch.body[0])
  ) {
    branch = branch.body[0];
  }
  if (branch.type !== "ReturnStatement") return null;
  const returned = sourceNode(branch.argument) && ast.unwrap(branch.argument);
  return returned && ast.binding(returned) === binding ? returned : node;
}

function hasOnlyIdentityUses(
  ast: SourceAst,
  result: SourceNode,
  uses: Map<SourceNode, Set<SourceNode>>,
): boolean {
  for (const node of ast.nodes) {
    if (!isReference(ast, node)) continue;
    const binding = ast.binding(node);
    const allowed = binding && uses.get(binding);
    if (!allowed || allowed.has(node)) continue;
    const returned = binding === result && failureGuard(ast, node, result);
    if (!returned) return false;
    allowed.add(returned);
  }
  return true;
}

/** A point lookup can use the original parameter ID for the update too. This
 * form requires the parameter to be used only at those two addresses. */
function samePointId(
  ast: SourceAst,
  lookupArg: unknown,
  updateArg: SourceNode,
  block: SourceNode,
): boolean {
  if (!sourceNode(lookupArg)) return false;
  const left = pathOf(ast, lookupArg);
  const right = pathOf(ast, updateArg);
  if (
    !left || !right || left.root.name !== right.root.name ||
    left.fields.join(".") !== right.fields.join(".")
  ) return false;
  const params = ast.parent(block)?.params;
  const binding = ast.binding(left.root);
  if (
    left.fields.length === 0 && binding && ast.binding(right.root) === binding
  ) {
    return ast.constant(left.root) !== null;
  }
  const param = Array.isArray(params) &&
    params.find((p: unknown) =>
      sourceNode(p) && p.type === "Identifier" && p.name === left.root.name
    );
  return !!param &&
    ast.nodes.every((node) =>
      !isReference(ast, node) || node.name !== left.root.name ||
      node === param || node === left.root || node === right.root
    );
}

/** Prove the narrow local form: an awaited lookup contributes only the row ID
 * to an awaited lock, followed by an update of that row in the same block.
 * The caller still pairs every unproved read with writes, including helper
 * slices, and must account for all updates of the resource. */
export function identityOnlyLookup(
  source: string,
  calls: readonly RowCall[],
  readVerbs: ReadonlySet<string>,
): number | undefined {
  const updates = calls.filter(({ verb }) => verb === "update");
  const reads = calls.filter(({ verb }) => readVerbs.has(verb));
  const locks = calls.filter(({ verb }) => verb === "findForUpdate");
  if (updates.length !== 1 || reads.length !== 1 || locks.length !== 1) return;
  const parsed = functionSource(source);
  if (!parsed) return;
  const { ast, prefix } = parsed;
  const positions = new Map<number, SourceNode>();
  for (const node of ast.nodes) {
    if (
      node.type === "CallExpression" && sourceNode(node.callee) &&
      sourceNode(node.callee.property) &&
      typeof node.callee.property.start === "number"
    ) {
      positions.set(node.callee.property.start - prefix, node);
    }
  }
  const read = positions.get(reads[0]!.methodOffset);
  const lock = positions.get(locks[0]!.methodOffset);
  const update = positions.get(updates[0]!.methodOffset);
  if (
    !read || !lock || !update || !Array.isArray(read.arguments) ||
    !Array.isArray(lock.arguments) || !Array.isArray(update.arguments) ||
    !sameReceiver(ast, read, lock) || !sameReceiver(ast, lock, update)
  ) return;
  const lookup = awaitedResult(ast, read);
  const held = awaitedResult(ast, lock);
  const write = updateStatement(ast, update);
  const block = write && ast.parent(write);
  if (
    !lookup || !held || block?.type !== "BlockStatement" ||
    ast.parent(lookup.statement) !== block ||
    ast.parent(held.statement) !== block ||
    !(read.start! < lock.start! && lock.start! < update.start!)
  ) return;
  const [lockArg] = lock.arguments;
  const [updateArg] = update.arguments;
  if (!sourceNode(lockArg) || !sourceNode(updateArg)) return;
  const uses = new Map<SourceNode, Set<SourceNode>>();
  if (!lookupId(ast, lockArg, lookup.init, uses)) return;
  const target = pathOf(ast, updateArg);
  const lockedId = target && target.fields.join(".") === "value.id" &&
    ast.binding(target.root) === held.init &&
    hasOnlyIdentityUses(
      ast,
      held.init,
      new Map([[
        held.init,
        new Set(
          ast.nodes.filter((node) =>
            node.start! >= update.start! && node.end! <= update.end!
          ),
        ),
      ]]),
    );
  if (
    !lockedId && !lookupId(ast, updateArg, lookup.init, uses) &&
    !(["find", "findOrFail"].includes(reads[0]!.verb) &&
      samePointId(ast, read.arguments[0], updateArg, block))
  ) return;
  if (hasOnlyIdentityUses(ast, lookup.init, uses)) {
    return reads[0]!.methodOffset;
  }
}
