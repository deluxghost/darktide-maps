import {edgeLength, positionKey} from "./geometry.mjs";

export function createComponents(edges) {
	const vertexToComponent = new Map();
	const components = [];

	for (const edge of edges) {
		const keys = [positionKey(edge.a), positionKey(edge.b)];
		const existing = [...new Set(keys.map((key) => vertexToComponent.get(key)).filter((id) => id !== undefined))];
		let component;

		if (existing.length === 0) {
			component = {
				edges: [],
				totalLength: 0,
			};
			components.push(component);
		} else {
			component = components[existing[0]];

			for (let index = 1; index < existing.length; index++) {
				const other = components[existing[index]];

				if (other === component) {
					continue;
				}

				component.edges.push(...other.edges);
				component.totalLength += other.totalLength;
				other.edges = [];
				other.totalLength = 0;

				for (const otherEdge of component.edges) {
					vertexToComponent.set(positionKey(otherEdge.a), existing[0]);
					vertexToComponent.set(positionKey(otherEdge.b), existing[0]);
				}
			}
		}

		component.edges.push(edge);
		component.totalLength += edgeLength(edge);

		for (const key of keys) {
			vertexToComponent.set(key, components.indexOf(component));
		}
	}

	return components.filter((component) => component.edges.length > 0);
}
