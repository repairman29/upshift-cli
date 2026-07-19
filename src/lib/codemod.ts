/**
 * codemod.ts — AST-aware code transformations using ts-morph.
 *
 * Provides structured transforms on top of the line-level regex approach in fix.ts.
 * Transforms fall back to the caller's regex/literal path if ts-morph can't parse the file.
 *
 * Supported transform types:
 *   rename-import-source    — change the 'from' path of an import declaration
 *   add-named-import        — add a named import (creates statement if needed)
 *   remove-named-import     — remove a named import; removes whole statement if empty
 *   rename-named-import     — rename a named export (ImportSpecifier)
 *   rename-member-access    — rename `Obj.prop` → `NewObj.newProp` everywhere
 *   replace-member-call     — replace `obj.method(arg0, arg1)` with a template expression
 *                             using {arg0} {arg1} placeholders (handles argument reordering)
 */

import path from "path";
import { readFileSync, writeFileSync } from "fs";
import { createTwoFilesPatch } from "diff";

// Lazy-import ts-morph to avoid startup cost when AST is not used
async function getTsMorph() {
  const { Project, SyntaxKind } = await import("ts-morph");
  return { Project, SyntaxKind };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ASTTransformType =
  | "rename-import-source"
  | "add-named-import"
  | "remove-named-import"
  | "rename-named-import"
  | "rename-member-access"
  | "replace-member-call";

export type ASTTransform = {
  type: ASTTransformType;
  description: string;
  // rename-import-source
  fromModule?: string;
  toModule?: string;
  // add-named-import / remove-named-import / rename-named-import
  importModule?: string; // the 'from' specifier to target
  importName?: string; // the named export to add/remove/rename
  importAlias?: string; // new name when renaming (toName)
  // rename-member-access
  objectName?: string; // e.g. 'ReactDOM'
  propertyName?: string; // e.g. 'render'
  newObjectName?: string; // e.g. 'ReactDOMClient'
  newPropertyName?: string; // e.g. 'createRoot'
  // replace-member-call: same objectName/propertyName +
  newExpression?: string; // template: use {arg0}, {arg1}, … for original arguments
  addImport?: {
    // optionally inject an import after replacement
    name: string;
    from: string;
    isDefault?: boolean;
  };
};

export type ASTCodeFix = {
  file: string;
  line: number;
  original: string;
  replacement: string;
  description: string;
  mode: "ast";
};

export type ASTApplyResult = {
  file: string;
  changed: boolean;
  fixes: ASTCodeFix[];
  diff?: string;
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if the transform type is supported and the required fields are present.
 */
export function canHandleWithAST(transform: ASTTransform): boolean {
  switch (transform.type) {
    case "rename-import-source":
      return !!(transform.fromModule && transform.toModule);
    case "add-named-import":
    case "remove-named-import":
      return !!(transform.importModule && transform.importName);
    case "rename-named-import":
      return !!(transform.importModule && transform.importName && transform.importAlias);
    case "rename-member-access":
      return !!(transform.objectName && transform.propertyName);
    case "replace-member-call":
      return !!(transform.objectName && transform.propertyName && transform.newExpression);
    default:
      return false;
  }
}

/**
 * Apply one AST transform across an array of files.
 * Returns per-file results. dryRun=true computes changes but doesn't write.
 */
export async function applyASTTransform(
  files: string[],
  transform: ASTTransform,
  dryRun: boolean,
  cwd: string
): Promise<ASTApplyResult[]> {
  const results: ASTApplyResult[] = [];

  // Only handle JS/TS family; non-JS files are skipped (caller uses regex fallback)
  const jsFiles = files.filter((f) => [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].some((ext) => f.endsWith(ext)));

  if (jsFiles.length === 0) return results;

  try {
    const { Project } = await getTsMorph();

    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        jsx: 4 as number, // JsxEmit.ReactJSX
      },
    });

    for (const filePath of jsFiles) {
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
      let originalContent: string;
      try {
        originalContent = readFileSync(absPath, "utf8");
      } catch {
        continue;
      }

      let sf;
      try {
        sf = project.createSourceFile(absPath, originalContent, { overwrite: true });
      } catch {
        results.push({ file: absPath, changed: false, fixes: [] });
        continue;
      }

      const fixes: ASTCodeFix[] = [];

      try {
        switch (transform.type) {
          case "rename-import-source":
            applyRenameImportSource(sf, transform, absPath, fixes);
            break;
          case "add-named-import":
            applyAddNamedImport(sf, transform, absPath, fixes);
            break;
          case "remove-named-import":
            applyRemoveNamedImport(sf, transform, absPath, fixes);
            break;
          case "rename-named-import":
            applyRenameNamedImport(sf, transform, absPath, fixes);
            break;
          case "rename-member-access":
            applyRenameMemberAccess(sf, transform, absPath, fixes);
            break;
          case "replace-member-call":
            await applyReplaceMemberCall(sf, transform, absPath, fixes, project);
            break;
        }
      } catch {
        // AST transform failed for this file — caller falls back to regex
        results.push({ file: absPath, changed: false, fixes: [] });
        project.removeSourceFile(sf);
        continue;
      }

      if (fixes.length > 0) {
        const newContent = sf.getFullText();
        const relPath = path.relative(cwd, absPath);
        const diff = createTwoFilesPatch(relPath, relPath, originalContent, newContent, "before", "after", {
          context: 3,
        });

        if (!dryRun) {
          writeFileSync(absPath, newContent, "utf8");
        }

        results.push({ file: absPath, changed: true, fixes, diff });
      } else {
        results.push({ file: absPath, changed: false, fixes: [] });
      }

      project.removeSourceFile(sf);
    }
  } catch {
    // ts-morph failed to load or project setup failed — return empty results
    // Caller falls back to regex
  }

  return results;
}

// ─── Transform implementations ────────────────────────────────────────────────

function applyRenameImportSource(
  sf: Awaited<ReturnType<typeof import("ts-morph").Project.prototype.createSourceFile>>,
  transform: ASTTransform,
  filePath: string,
  fixes: ASTCodeFix[]
): void {
  const imports = sf.getImportDeclarations();
  for (const imp of imports) {
    const specifier = imp.getModuleSpecifierValue();
    if (specifier === transform.fromModule) {
      const line = imp.getStartLineNumber();
      const original = imp.getFullText();
      imp.setModuleSpecifier(transform.toModule!);
      const replacement = imp.getFullText();
      fixes.push({
        file: filePath,
        line,
        original: original.trim(),
        replacement: replacement.trim(),
        description: transform.description,
        mode: "ast",
      });
    }
  }
}

function applyAddNamedImport(
  sf: Awaited<ReturnType<typeof import("ts-morph").Project.prototype.createSourceFile>>,
  transform: ASTTransform,
  filePath: string,
  fixes: ASTCodeFix[]
): void {
  const importName = transform.importName!;
  const importModule = transform.importModule!;

  // Find existing import from the module
  const existing = sf.getImportDeclaration((d) => d.getModuleSpecifierValue() === importModule);

  if (existing) {
    // Check if name is already imported
    const named = existing.getNamedImports().map((n) => n.getName());
    if (!named.includes(importName)) {
      const line = existing.getStartLineNumber();
      const original = existing.getFullText();
      existing.addNamedImport(importName);
      const replacement = existing.getFullText();
      fixes.push({
        file: filePath,
        line,
        original: original.trim(),
        replacement: replacement.trim(),
        description: transform.description,
        mode: "ast",
      });
    }
  } else {
    // Add a new import declaration at the top
    const insertPos = sf.getImportDeclarations().length;
    const newImport = sf.insertImportDeclaration(insertPos, {
      namedImports: [importName],
      moduleSpecifier: importModule,
    });
    fixes.push({
      file: filePath,
      line: newImport.getStartLineNumber(),
      original: "",
      replacement: newImport.getFullText().trim(),
      description: transform.description,
      mode: "ast",
    });
  }
}

function applyRemoveNamedImport(
  sf: Awaited<ReturnType<typeof import("ts-morph").Project.prototype.createSourceFile>>,
  transform: ASTTransform,
  filePath: string,
  fixes: ASTCodeFix[]
): void {
  const existing = sf.getImportDeclaration((d) => d.getModuleSpecifierValue() === transform.importModule);
  if (!existing) return;

  const specifier = existing.getNamedImports().find((n) => n.getName() === transform.importName);
  if (!specifier) return;

  const line = existing.getStartLineNumber();
  const original = existing.getFullText();

  specifier.remove();

  // If no named imports remain and no default/namespace, remove the whole statement
  if (existing.getNamedImports().length === 0 && !existing.getDefaultImport() && !existing.getNamespaceImport()) {
    existing.remove();
    fixes.push({
      file: filePath,
      line,
      original: original.trim(),
      replacement: "",
      description: transform.description,
      mode: "ast",
    });
  } else {
    const replacement = existing.getFullText();
    fixes.push({
      file: filePath,
      line,
      original: original.trim(),
      replacement: replacement.trim(),
      description: transform.description,
      mode: "ast",
    });
  }
}

function applyRenameNamedImport(
  sf: Awaited<ReturnType<typeof import("ts-morph").Project.prototype.createSourceFile>>,
  transform: ASTTransform,
  filePath: string,
  fixes: ASTCodeFix[]
): void {
  const existing = sf.getImportDeclaration((d) => d.getModuleSpecifierValue() === transform.importModule);
  if (!existing) return;

  const specifier = existing.getNamedImports().find((n) => n.getName() === transform.importName);
  if (!specifier) return;

  const line = existing.getStartLineNumber();
  const original = existing.getFullText();

  specifier.setName(transform.importAlias!);

  const replacement = existing.getFullText();
  fixes.push({
    file: filePath,
    line,
    original: original.trim(),
    replacement: replacement.trim(),
    description: transform.description,
    mode: "ast",
  });
}

function applyRenameMemberAccess(
  sf: Awaited<ReturnType<typeof import("ts-morph").Project.prototype.createSourceFile>>,
  transform: ASTTransform,
  filePath: string,
  fixes: ASTCodeFix[]
): void {
  // Find all PropertyAccessExpressions matching objectName.propertyName
  sf.forEachDescendant((node) => {
    // Use string check to avoid importing SyntaxKind at top level
    if (node.getKindName() !== "PropertyAccessExpression") return;
    const pae = node as import("ts-morph").PropertyAccessExpression;
    const expr = pae.getExpression();
    const propName = pae.getName();

    if (expr.getText() === transform.objectName && propName === transform.propertyName) {
      const line = pae.getStartLineNumber();
      const original = pae.getText();

      const newObj = transform.newObjectName ?? transform.objectName!;
      const newProp = transform.newPropertyName ?? transform.propertyName!;
      const replacement = `${newObj}.${newProp}`;

      pae.replaceWithText(replacement);

      fixes.push({
        file: filePath,
        line,
        original,
        replacement,
        description: transform.description,
        mode: "ast",
      });
    }
  });
}

async function applyReplaceMemberCall(
  sf: Awaited<ReturnType<typeof import("ts-morph").Project.prototype.createSourceFile>>,
  transform: ASTTransform,
  filePath: string,
  fixes: ASTCodeFix[],
  project: import("ts-morph").Project
): Promise<void> {
  const callsToReplace: Array<{
    node: import("ts-morph").CallExpression;
    line: number;
    originalText: string;
    replacement: string;
  }> = [];

  // Collect first, then replace (avoid modifying tree while traversing)
  sf.forEachDescendant((node) => {
    if (node.getKindName() !== "CallExpression") return;
    const call = node as import("ts-morph").CallExpression;
    const expr = call.getExpression();

    if (expr.getKindName() !== "PropertyAccessExpression") return;
    const pae = expr as import("ts-morph").PropertyAccessExpression;

    if (pae.getExpression().getText() === transform.objectName && pae.getName() === transform.propertyName) {
      const args = call.getArguments().map((a) => a.getText());
      let replacement = transform.newExpression!;

      // Replace {arg0}, {arg1}, ... placeholders with actual argument text
      args.forEach((arg, i) => {
        replacement = replacement.replace(new RegExp(`\\{arg${i}\\}`, "g"), arg);
      });

      // Replace any remaining unfilled placeholders with empty string
      replacement = replacement.replace(/\{arg\d+\}/g, "");

      callsToReplace.push({
        node: call,
        line: call.getStartLineNumber(),
        originalText: call.getText(),
        replacement,
      });
    }
  });

  // Replace in reverse order to preserve positions
  for (const item of callsToReplace.reverse()) {
    item.node.replaceWithText(item.replacement);
    fixes.push({
      file: filePath,
      line: item.line,
      original: item.originalText,
      replacement: item.replacement,
      description: transform.description,
      mode: "ast",
    });
  }

  // Inject additional import if specified
  if (transform.addImport && fixes.length > 0) {
    const { name, from: fromModule, isDefault } = transform.addImport;
    const existingImport = sf.getImportDeclaration((d) => d.getModuleSpecifierValue() === fromModule);

    if (existingImport) {
      const named = existingImport.getNamedImports().map((n) => n.getName());
      const hasDefault = existingImport.getDefaultImport()?.getText() === name;
      if (!named.includes(name) && !hasDefault) {
        if (isDefault) {
          existingImport.setDefaultImport(name);
        } else {
          existingImport.addNamedImport(name);
        }
      }
    } else {
      const insertPos = sf.getImportDeclarations().length;
      if (isDefault) {
        sf.insertImportDeclaration(insertPos, { defaultImport: name, moduleSpecifier: fromModule });
      } else {
        sf.insertImportDeclaration(insertPos, { namedImports: [name], moduleSpecifier: fromModule });
      }
    }
  }
}
