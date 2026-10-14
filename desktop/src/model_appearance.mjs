// Shared by Electron and the web viewer. Diagnostic and multi-body colors stay separate.
export const MODEL_COLOR = Object.freeze({ light: '#167ac2', dark: '#329eea' });
export const MODEL_MATERIAL = Object.freeze({ roughness: 0.42, metalness: 0.06 });
export const MODEL_LIGHTING = Object.freeze({
  hemisphere: { sky: 0xeff6ff, ground: 0x233449, intensity: 1.15 },
  key: { color: 0xffffff, intensity: 2.6, position: [30, -50, 70] },
  fill: { color: 0x87caff, intensity: 0.65, position: [-50, 15, 35] },
  rim: { color: 0xb9dfff, intensity: 0.85, position: [-30, 50, 40] },
});

// The implicit preview uses its own shading, so reproduce the blue surface and
// broad specular highlights here without changing the shared Qt ray marcher.
export function styleImplicitSurface(source) {
  const rgb = color => [1, 3, 5].map(index => (parseInt(color.slice(index, index + 2), 16) / 255).toFixed(6)).join(', ');
  return source.replace(
    /vec3 n = hitNormal;[\s\S]*?frag_color = vec4\(color, 1\.0\); return;/,
    `vec3 n = hitNormal; vec3 viewDir = normalize(ro - hitPos);
        vec3 key = normalize(vec3(0.35, -0.55, 0.75));
        vec3 fill = normalize(vec3(-0.70, 0.21, 0.49));
        vec3 edge = normalize(vec3(-0.42, 0.70, 0.56));
        float diffuse = 0.28 + 0.68 * max(dot(n, key), 0.0) + 0.22 * max(dot(n, fill), 0.0);
        float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
        float specular = pow(max(dot(n, normalize(key + viewDir)), 0.0), 40.0);
        float soft_specular = pow(max(dot(n, normalize(fill + viewDir)), 0.0), 16.0);
        vec3 base = mix(vec3(${rgb(MODEL_COLOR.dark)}), vec3(${rgb(MODEL_COLOR.light)}), u_lightBg);
        float rim = fresnel * (0.45 + 0.55 * max(dot(n, edge), 0.0)) * mix(0.24, 0.12, u_lightBg);
        vec3 color = base * diffuse + vec3(0.86, 0.94, 1.0) * (0.30 * specular + 0.05 * soft_specular)
            + vec3(0.45, 0.75, 1.0) * rim;
        color = pow(clamp(color, 0.0, 1.0), vec3(0.88)); frag_color = vec4(color, 1.0); return;`
  );
}
