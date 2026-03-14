# Attribution

This project was built with reference to the following open-source repositories. A sincere thank you to the original authors for their work.

---

## mjyoo2/OverleafMCP

**Repository:** https://github.com/mjyoo2/OverleafMCP  
**License:** None specified (all rights reserved by default)

This project originated as a fork of mjyoo2/OverleafMCP. The initial structure,
Overleaf Git integration approach, and core tool concepts (`list_projects`,
`list_files`, `read_file`, `get_sections`, `get_section_content`, `write_file`,
`write_section`) were informed by this work. The codebase has since been
substantially rewritten.

---

## GhoshSrinjoy/Overleaf-mcp

**Repository:** https://github.com/GhoshSrinjoy/Overleaf-mcp  
**License:** MIT License

Copyright (c) 2025 GhoshSrinjoy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The following architectural patterns and features were inspired by this work:
- `PROJECTS_FILE` and `OVERLEAF_TEMP_DIR` environment variable configuration
- Git author identity injection via environment variables
- `list_history` and `get_diff` tool concepts
- `dryRun` and `push` parameters on write operations
- `additionalProperties: false` on all tool input schemas
- Section content preview in `get_sections` output