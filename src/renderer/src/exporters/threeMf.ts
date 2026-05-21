import JSZip from 'jszip'
import type { TriangleMesh } from '../mesh/types'

function buildModelXml(mesh: TriangleMesh): string {
  const verts: string[] = []
  const tris: string[] = []
  const p = mesh.positions
  const n = p.length / 3
  for (let i = 0; i < n; i++) {
    const o = i * 3
    verts.push(`<vertex x="${p[o]}" y="${p[o + 1]}" z="${p[o + 2]}" />`)
  }
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]
    const b = mesh.indices[t + 1]
    const c = mesh.indices[t + 2]
    tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}" />`)
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <metadata name="Title">ModelForge export</metadata>
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          ${verts.join('\n          ')}
        </vertices>
        <triangles>
          ${tris.join('\n          ')}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" />
  </build>
</model>`
}

/** Packaged 3MF from `TriangleMesh` only (viewer preview meshes are not used). */
export async function encodeThreeMf(mesh: TriangleMesh): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`)
  zip.folder('_rels')!.file('.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/>
</Relationships>`)
  zip.folder('3D')!.file('3dmodel.model', buildModelXml(mesh))
  const buf = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return buf
}
