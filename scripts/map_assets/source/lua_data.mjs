import {readFile} from "node:fs/promises";
import luaparse from "luaparse";

const [mode, ...files] = process.argv.slice(2);

function evaluate(node, locals) {
	if (node.type === "ResolvedValue") return node.value;
	if (["StringLiteral", "NumericLiteral", "BooleanLiteral", "NilLiteral"].includes(node.type)) return node.value;
	if (node.type === "Identifier") {
		if (!locals.has(node.name)) throw new Error(`Unknown data-table local: ${node.name}`);
		return evaluate(locals.get(node.name), locals);
	}
	if (node.type === "UnaryExpression" && node.operator === "-") return -evaluate(node.argument, locals);
	if (node.type === "MemberExpression") return evaluate(node.base, locals)[node.identifier.name];
	if (node.type === "BinaryExpression" && ["+", "-", "<"].includes(node.operator)) {
		const left = evaluate(node.left, locals), right = evaluate(node.right, locals);
		return node.operator === "+" ? left + right : node.operator === "-" ? left - right : left < right;
	}
	if (node.type === "CallExpression" && (node.base.base?.name === "string" && node.base.identifier?.name === "format"
		|| node.base.type === "Identifier" && locals.has(node.base.name))) {
		const direct = node.base.type === "MemberExpression";
		const format = direct ? evaluate(node.arguments[0], locals) : evaluate(node.base, locals).format;
		let index = direct ? 1 : 0;
		if (typeof format !== "string") throw new Error("Unsupported static formatting function");
		return format.replace(/%([0-9]*)([sd])/g, (_, width, kind) => {
			const value = evaluate(node.arguments[index++], locals);
			if (kind === "d" && !Number.isInteger(value)) throw new Error("Non-integer static format argument");
			return String(value).padStart(Number(width || 0), width.startsWith("0") ? "0" : " ");
		});
	}
	if (node.type === "CallExpression" && ["Vector3Box", "Vector3"].includes(node.base.name) && node.arguments.length === 3) {
		return node.arguments.map((argument) => evaluate(argument, locals));
	}
	if (node.type !== "TableConstructorExpression") throw new Error(`Non-literal data expression: ${node.type}`);
	const entries = [];
	let index = 1;
	for (const field of node.fields) {
		const key = field.type === "TableValue" ? index++
			: field.type === "TableKeyString" ? field.key.name : evaluate(field.key, locals);
		entries.push([key, evaluate(field.value, locals)]);
	}
	if (entries.length && entries.every(([key], i) => key === i + 1)) return entries.map(([, value]) => value);
	return Object.fromEntries(entries);
}

function tableNode(node, locals) {
	if (node.type === "Identifier") return tableNode(locals.get(node.name), locals);
	if (node.type === "CallExpression" && node.base.name === "settings" && node.arguments.length === 2) {
		return tableNode(node.arguments[1], locals);
	}
	if (node.type !== "TableConstructorExpression") throw new Error("Expected a literal table");
	return node;
}

function projectFields(node, fields, locals) {
	return Object.fromEntries(tableNode(node, locals).fields.filter((field) => field.type === "TableKeyString"
		&& fields.includes(field.key.name)).map((field) => [field.key.name, evaluate(field.value, locals)]));
}

function walk(node, visit) {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
	visit(node);
	Object.values(node).forEach((child) => walk(child, visit));
}

function parseData(ast) {
	const locals = new Map();
	for (const statement of ast.body) {
		if (!["LocalStatement", "AssignmentStatement"].includes(statement.type)) continue;
		statement.variables.forEach((variable, index) => {
			if (variable.type === "Identifier") locals.set(variable.name, statement.init[index]);
		});
	}
	if (mode.startsWith("select:") || mode.startsWith("formatter:")) {
		const wanted = mode.slice(mode.indexOf(":") + 1).split(".");
		const memberPath = (node) => node.type === "Identifier" ? [node.name]
			: node.type === "MemberExpression" ? [...memberPath(node.base), node.identifier.name] : [];
		let selected = locals.get(wanted[0]);
		let consumed = 1;
		for (const statement of ast.body) {
			if (statement.type !== "AssignmentStatement") continue;
			const assigned = memberPath(statement.variables[0]);
			if (assigned.length <= consumed || assigned.length > wanted.length
				|| !assigned.every((key, index) => key === wanted[index])) continue;
			selected = statement.init[0];
			consumed = assigned.length;
		}
		for (const key of wanted.slice(consumed)) {
			selected = tableNode(selected, locals).fields.find((field) => field.type === "TableKeyString" && field.key.name === key)?.value;
			if (!selected) throw new Error(`Missing Lua data field: ${wanted.join(".")}`);
		}
		if (mode.startsWith("formatter:")) {
			const returned = selected.body.find((node) => node.type === "ReturnStatement");
			const call = returned?.arguments[0];
			if (call?.base.base?.name !== "string" || call.base.identifier?.name !== "format") throw new Error("Unsupported name formatter");
			return {format: evaluate(call.arguments[0], locals)};
		}
		return evaluate(selected, locals);
	}
	if (["registry", "pickup_registry", "objective_registry", "boss_registry", "breed_registry"].includes(mode)) {
		const functionName = {registry: "_extract_mission_templates", pickup_registry: "_create_pickup_entry",
			objective_registry: "_create_mission_objective_template_entry", boss_registry: "_create_boss_template_entry",
			breed_registry: "_create_breed_entry"}[mode];
		return ast.body.filter((statement) => statement.type === "CallStatement"
			&& statement.expression.base.name === functionName)
			.map((statement) => evaluate(statement.expression.arguments[0], locals));
	}
	if (mode === "component") {
		const assignment = ast.body.find((statement) => statement.type === "AssignmentStatement"
			&& statement.variables[0].type === "MemberExpression"
			&& statement.variables[0].identifier.name === "component_data");
		if (!assignment) throw new Error("Missing component_data definition");
		const definition = evaluate(assignment.init[0], locals);
		return Object.fromEntries(Object.entries(definition).filter(([, field]) => Object.hasOwn(field, "value")
			|| Object.hasOwn(field, "values") || field.size === 0 && field.ui_type?.endsWith("_array"))
			.map(([key, field]) => [key, field.value ?? field.values ?? []]));
	}
	if (mode === "scripted_pickups") {
		const directionals = new Map();
		walk(ast, (node) => {
			if (node.type !== "LocalStatement") return;
			node.init.forEach((value, index) => {
				if (value.type === "CallExpression" && value.base.identifier?.name === "get_directional_unit") {
					directionals.set(node.variables[index].name, evaluate(value.arguments[0], locals));
				}
			});
		});
		const result = [];
		walk(ast, (node) => {
			if (node.type !== "CallExpression" || node.base.identifier?.name !== "spawn_pickup") return;
			const position = node.arguments[1];
			if (position.type !== "CallExpression" || position.base.identifier?.name !== "local_position") {
				throw new Error("Scripted pickup does not use a directional unit position");
			}
			const identifier = directionals.get(position.arguments[0].name);
			if (!identifier) throw new Error("Missing scripted pickup directional binding");
			result.push({identifier, pickup: evaluate(node.arguments[0], locals)});
		});
		return result;
	}
	if (mode === "scripted_boss_spawns") {
		const result = new Map();
		walk(ast, (fn) => {
			if (fn.type !== "FunctionDeclaration") return;
			const positions = new Map();
			walk(fn.body, (node) => {
				if (node.type !== "LocalStatement") return;
				node.init.forEach((value, index) => {
					if (value.type !== "CallExpression" || value.base.identifier?.name !== "position") return;
					const selection = value.base.base;
					if (selection.type !== "IndexExpression" || selection.index.value !== 1) return;
					const call = selection.base;
					if (call.type === "CallExpression" && call.base.identifier?.name === "spawners_in_group"
						&& call.arguments[0].type === "StringLiteral") {
						positions.set(node.variables[index].name, call.arguments[0].value);
					}
				});
			});
			walk(fn.body, (call) => {
				if (call.type !== "CallExpression" || call.base.identifier?.name !== "spawn_minion"
					|| call.arguments[0]?.type !== "StringLiteral") return;
				const group = positions.get(call.arguments[1]?.name);
				if (!group) return;
				const breed = call.arguments[0].value;
				result.set(group + "|" + breed, {spawner_group: group, breed_name: breed});
			});
		});
		return [...result.values()];
	}
	const returned = ast.body.findLast((statement) => statement.type === "ReturnStatement");
	if (!returned) throw new Error("Missing data-table return statement");
	if (mode === "table") return evaluate(returned.arguments[0], locals);
	if (mode === "breed_markers") {
		const table = tableNode(returned.arguments[0],locals);
		const result = projectFields(table,["name","is_boss"],locals);
		const display = table.fields.find((field) => field.key?.name === "display_name")?.value;
		if (!display) return result;
		if (display.type === "StringLiteral") result.display_name = display.value;
		else if (display.type === "MemberExpression" && display.base.name === "BossNameTemplates") {
			result.boss_name_template = display.identifier.name;
		} else throw new Error("Unsupported breed display-name source");
		return result;
	}
	if (mode.startsWith("fields:")) return projectFields(returned.arguments[0], mode.slice(7).split(","), locals);
	if (mode === "interactions") return Object.fromEntries(tableNode(returned.arguments[0], locals).fields.map((field) =>
		[field.key.name, projectFields(field.value, ["description", "ui_interaction_type", "ui_view_name"], locals)]));
	if (mode === "objectives" || mode.startsWith("objectives:")) {
		const fields = ["header", "description", "hidden", "mission_objective_type"];
		const result = Object.fromEntries(tableNode(returned.arguments[0], locals).fields.map((mission) => {
		const objectives = tableNode(mission.value, locals).fields.find((field) => field.key?.name === "objectives");
		return [mission.key.name, Object.fromEntries(tableNode(objectives.value, locals).fields.map((field) =>
			[field.key.name, projectFields(field.value, fields, locals)]))];
		}));
		const context = mode.startsWith("objectives:") ? JSON.parse(mode.slice(11)) : {};
		const scope = new Map(locals);
		for (const [name, value] of Object.entries(context)) scope.set(name, {type:"ResolvedValue", value});
		const memberPath = (node, env) => {
			if (node.type === "Identifier") return env.has(node.name) && env.get(node.name)?.type === "MemberExpression"
				? memberPath(env.get(node.name), env) : [node.name];
			return node.type === "MemberExpression" ? [...memberPath(node.base, env), node.identifier.name] : [];
		};
		function statements(body, env) {
			for (const node of body) {
				if (node.type === "LocalStatement") node.variables.forEach((v,i) => env.set(v.name,node.init[i]));
				else if (node.type === "ForNumericStatement") {
					const start = evaluate(node.start,env), end = evaluate(node.end,env);
					for (let i=start;i<=end;i++) statements(node.body,new Map([...env,[node.variable.name,{type:"ResolvedValue",value:i}]]));
				} else if (node.type === "IfStatement") {
					const branch = node.clauses.find((clause) => !clause.condition || evaluate(clause.condition,env));
					if (branch) statements(branch.body,new Map(env));
				} else if (node.type === "AssignmentStatement" && node.variables[0].type === "IndexExpression") {
					const target = node.variables[0], path = memberPath(target.base,env);
					if (path.at(-1) !== "objectives" || !result[path.at(-2)]) continue;
					result[path.at(-2)][evaluate(target.index,env)] = projectFields(node.init[0],fields,env);
				}
			}
		}
		statements(ast.body.filter((node) => node.type === "ForNumericStatement"),scope);
		return result;
	}
	if (mode === "terror_spawns") {
		const result = [];
		walk(ast, (node) => {
			if (node.type !== "TableConstructorExpression") return;
			const action = node.fields.find((field) => field.type === "TableValue")?.value;
			if (action?.type !== "StringLiteral" || !action.value.startsWith("spawn_")) return;
			result.push({action: action.value, ...projectFields(node,
				["spawner_group", "spawner_id", "breed_name", "breed_tags", "mission_objective_id", "position"], locals)});
		});
		return result;
	}
	if (mode !== "missions") throw new Error(`Unknown Lua data mode: ${mode}`);
	const fields = new Set(["level", "mission_name", "zone_id", "mechanism_name", "game_mode_name", "terror_event_templates"]);
	const missions = tableNode(returned.arguments[0], locals);
	return Object.fromEntries(missions.fields.map((mission) => {
		if (mission.type !== "TableKeyString") throw new Error("Unexpected mission key");
		const data = tableNode(mission.value, locals);
		return [mission.key.name, Object.fromEntries(data.fields.filter((field) => field.type === "TableKeyString"
			&& fields.has(field.key.name)).map((field) => [field.key.name, evaluate(field.value, locals)]))];
	}));
}

const results = [];
for (const file of files) {
	const source = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
	const ast = luaparse.parse(source, {luaVersion: "LuaJIT", encodingMode: "pseudo-latin1", comments: false});
	try {
		results.push(parseData(ast));
	} catch (error) {
		throw new Error(`${file}: ${error.message}`, {cause: error});
	}
}
process.stdout.write(`${JSON.stringify(results)}\n`);
