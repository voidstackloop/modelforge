import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import type { ChatOptions } from "./providers/types";

export interface Project {
    id: string;
    name: string;
    instructions: string;
    params?: ChatOptions | null;
    createdAt: string;
    updatedAt: string;
}

function filePath(): string {
    return path.join(app.getPath("userData"), "projects.json");
}

function readAll(): Project[] {
    try {
        return JSON.parse(fs.readFileSync(filePath(), "utf-8"));
    } catch {
        return [];
    }
}

function writeAll(projects: Project[]): void {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(projects, null, 2));
}

export function listProjects(): Project[] {
    return readAll().sort((a, b) => a.name.localeCompare(b.name));
}

export function getProject(id: string): Project | null {
    return readAll().find((p) => p.id === id) ?? null;
}

export function createProject(name: string): Project {
    const now = new Date().toISOString();
    const project: Project = {
        id: randomUUID(),
        name: name.trim() || "Untitled project",
        instructions: "",
        createdAt: now,
        updatedAt: now,
    };
    const all = readAll();
    all.push(project);
    writeAll(all);
    return project;
}

export function updateProject(
    id: string,
    partial: Partial<Pick<Project, "name" | "instructions" | "params">>
): Project | null {
    const all = readAll();
    const idx = all.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    all[idx] = { ...all[idx], ...partial, updatedAt: new Date().toISOString() };
    writeAll(all);
    return all[idx];
}

export function deleteProject(id: string): void {
    writeAll(readAll().filter((p) => p.id !== id));
}
