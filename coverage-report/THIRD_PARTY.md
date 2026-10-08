# Coverage report dependencies

The coverage report JAR contains the following unmodified libraries. Their licenses
apply to their code independently of Blockwright's MIT license. Complete license
texts are included in `META-INF/blockwright/licenses/` in the JAR and distributed
alongside the native bundle. Upstream notices, where present, are preserved under
`META-INF/blockwright/upstream/`.

| Artifact | Version | License | Corresponding source |
| --- | --- | --- | --- |
| org.jacoco.core, org.jacoco.report | 0.8.13 | EPL-2.0 | https://github.com/jacoco/jacoco/tree/v0.8.13 |
| asm, asm-tree, asm-commons | 9.8 | BSD-3-Clause | https://gitlab.ow2.org/asm/asm/-/tree/ASM_9_8 |
| gson | 2.10.1 | Apache-2.0 | https://github.com/google/gson/tree/gson-parent-2.10.1 |

License text sources: JaCoCo's `LICENSE.md` at v0.8.13, Eclipse's EPL-2.0 text,
ASM's `LICENSE.txt` at ASM_9_8, and Gson's `LICENSE` at gson-parent-2.10.1.
Update this inventory and the texts when changing Java dependencies.
