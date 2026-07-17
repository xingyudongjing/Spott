import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

interface ProtectedOperation {
  method: "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";
  path: string;
}

interface PermissionEvidence extends ProtectedOperation {
  requestId: string | null;
  status: number;
}

const operationPattern = /^ {4}(delete|get|head|options|patch|post|put):\s*$/;
const pathPattern = /^ {2}(\/[^:]+):\s*$/;
const publicSecurityPattern = /^ {6}security:\s*\[\]\s*$/;
const placeholderValue = "019d0000-0000-7000-8000-000000000099";
const permissionMatrixDeviceId = "019d0000-0000-7000-8000-000000000098";

test("every OpenAPI-protected operation rejects an anonymous raw request without leaking credentials", async ({ request }) => {
  const apiBaseURL = process.env.SPOTT_API_BASE_URL;
  expect(apiBaseURL, "SPOTT_API_BASE_URL is required for the runtime permission matrix").toBeTruthy();

  const source = await readFile(path.resolve("packages/contracts/openapi.yaml"), "utf8");
  const operations = protectedOperations(source);
  expect(operations.length, "guard against silently parsing an empty or partial OpenAPI matrix").toBeGreaterThan(80);

  const evidence: PermissionEvidence[] = [];
  for (const operation of operations) {
    const concretePath = operation.path.replaceAll(/\{[^}]+\}/g, placeholderValue);
    const hasJSONBody = ["PATCH", "POST", "PUT"].includes(operation.method);
    const response = await request.fetch(`${apiBaseURL}${concretePath}`, {
      method: operation.method,
      failOnStatusCode: false,
      headers: {
        accept: "application/json",
        "x-spott-device-id": permissionMatrixDeviceId,
        ...(hasJSONBody ? { "content-type": "application/json" } : {}),
      },
      ...(hasJSONBody ? { data: {} } : {}),
    });
    const responseText = await response.text();
    const status = response.status();
    const requestId = response.headers()["x-request-id"] ?? null;

    expect(
      [401, 403],
      `${operation.method} ${operation.path} must reject an anonymous raw request; body=${responseText.slice(0, 240)}`,
    ).toContain(status);
    expect(
      responseText,
      `${operation.method} ${operation.path} leaked a credential-shaped field in its denial response`,
    ).not.toMatch(/"(?:accessToken|deviceBindingProof|identityToken|refreshToken|signedPayload)"\s*:/i);
    expect(requestId, `${operation.method} ${operation.path} omitted the request correlation header`).toMatch(/^req_/);

    evidence.push({ ...operation, requestId, status });
  }

  const outputDirectory = path.resolve("output/playwright");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, "api-permission-matrix.json"),
    `${JSON.stringify({ checkedAt: new Date().toISOString(), operations: evidence }, null, 2)}\n`,
    "utf8",
  );
});

function protectedOperations(source: string): ProtectedOperation[] {
  const lines = source.split(/\r?\n/);
  const operations: ProtectedOperation[] = [];
  let currentPath: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index] ?? "") && lines[index] !== "paths:") {
      currentPath = undefined;
      continue;
    }
    const pathMatch = lines[index]?.match(pathPattern);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    if (!currentPath) continue;

    const operationMatch = lines[index]?.match(operationPattern);
    if (!operationMatch) continue;

    let end = index + 1;
    while (end < lines.length) {
      const line = lines[end] ?? "";
      if (pathPattern.test(line) || operationPattern.test(line)) break;
      if (/^\S/.test(line)) break;
      end += 1;
    }
    const explicitlyPublic = lines.slice(index + 1, end).some((line) => publicSecurityPattern.test(line));
    if (!explicitlyPublic) {
      operations.push({
        method: operationMatch[1]!.toUpperCase() as ProtectedOperation["method"],
        path: currentPath,
      });
    }
  }

  return operations;
}
