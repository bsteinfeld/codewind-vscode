/*******************************************************************************
 * Copyright (c) 2019 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v2.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v20.html
 *
 * Contributors:
 *     IBM Corporation - initial API and implementation
 *******************************************************************************/

import * as vscode from "vscode";
import * as fs from "fs";
import { URL } from "url";

import Connection from "../../codewind/connection/Connection";
import Resources from "../../constants/Resources";
import generateManageReposHtml from "../webview/ManageTemplateReposPage";
import WebviewUtil from "../webview/WebviewUtil";
import Log from "../../Logger";
import Requester from "../../codewind/project/Requester";
import MCUtil from "../../MCUtil";
import Constants from "../../constants/Constants";
import EndpointUtil, { MCEndpoints } from "../../constants/Endpoints";
// import EndpointUtil, { MCEndpoints } from "../../constants/Endpoints";

/**
 * Template repository data as provided by the backend
 */
export interface IRawTemplateRepo {
    readonly url: string;
    readonly name: string;
    readonly description: string;
    readonly enabled: boolean;
    readonly protected: boolean;
}

export enum ManageReposWVMessages {
    ADD_NEW = "add-new",
    DELETE = "delete",
    HELP = "help",
    REFRESH = "refresh",
    ENABLE_DISABLE = "enableOrDisable",
}

/**
 * 'data' field of ENABLE_DISABLE event, which can be converted to an enablement request.
 */
export interface IRepoEnablementEvent {
    readonly repos: [{
        readonly repoID: string;
        readonly enable: boolean;
    }];
}

export const REPOS_PAGE_TITLE = "Template Repositories";

// Only allow one of these for now - This should be moved to be per-connection like how overview is per-project.
let manageReposPage: vscode.WebviewPanel | undefined;

export default async function manageTemplateReposCmd(connection: Connection): Promise<void> {
    if (manageReposPage) {
        // Show existing page
        manageReposPage.reveal();
        return;
    }

    const wvOptions: vscode.WebviewOptions & vscode.WebviewPanelOptions = {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(Resources.getBaseResourcePath())]
    };

    const title = REPOS_PAGE_TITLE;

    manageReposPage = vscode.window.createWebviewPanel(
        title,
        title,
        vscode.ViewColumn.Active,
        wvOptions
    );

    manageReposPage.reveal();
    manageReposPage.onDidDispose(() => {
        manageReposPage = undefined;
    });

    const icons = Resources.getIconPaths(Resources.Icons.Logo);
    manageReposPage.iconPath = {
        light: vscode.Uri.file(icons.light),
        dark:  vscode.Uri.file(icons.dark)
    };

    refreshPage(connection);
    manageReposPage.webview.onDidReceiveMessage(handleWebviewMessage.bind(connection));
}

async function refreshPage(connection: Connection): Promise<void> {
    if (!manageReposPage) {
        Log.e("Refreshing manage repos page but it doesn't exist");
        return;
    }
    const html = generateManageReposHtml(await fetchRepositoryList(connection));

    // For debugging in the browser, write out the html to an html file on disk and point to the resources on disk
    if (process.env[Constants.CW_ENV_VAR] === Constants.CW_ENV_DEV) {
        const htmlWithFileProto = html.replace(/vscode-resource:\//g, "file:///");
        fs.writeFile("/Users/tim/Desktop/manage.html", htmlWithFileProto,
            (err) => { if (err) { throw err; } }
        );
    }
    manageReposPage.webview.html = html;
}

async function handleWebviewMessage(this: Connection, msg: WebviewUtil.IWVMessage): Promise<void> {
    const connection = this;

    try {
        switch (msg.type) {
            case ManageReposWVMessages.ENABLE_DISABLE: {
                const enablement = msg.data as IRepoEnablementEvent;
                Log.i("Enable/Disable repos:", enablement);
                try {
                    await Requester.enableTemplateRepos(connection, enablement);
                }
                catch (err) {
                    // If any of the enablements fail, the checkboxes will be out of sync with the backend state, so refresh the page to reset
                    await refreshPage(connection);
                }
                break;
            }
            case ManageReposWVMessages.ADD_NEW: {
                // connection.addNewRepo
                Log.d("Adding new repo to " + connection.url);
                const repoInfo = await promptForNewRepo();
                if (!repoInfo) {
                    // cancelled
                    return;
                }

                try {
                    await Requester.addTemplateRepo(connection, repoInfo.repoUrl, repoInfo.description);
                    await refreshPage(connection);
                }
                catch (err) {
                    vscode.window.showErrorMessage(`Error adding new template repository: ${MCUtil.errToString(err)}`, err);
                    Log.e(`Error adding new template repo ${repoInfo}`, err);
                }
                break;
            }
            case ManageReposWVMessages.DELETE: {
                // connection.deleteRepo
                const repoUrl = msg.data as string;
                Log.d(`Delete repo ${repoUrl} from ${connection.url}`);
                try {
                    await Requester.removeTemplateRepo(connection, repoUrl);
                    await refreshPage(connection);
                }
                catch (err) {
                    vscode.window.showErrorMessage(`Error deleting template repository ${repoUrl}: ${MCUtil.errToString(err)}`, err);
                    Log.e(`Error removing template repo ${repoUrl}`, err);
                }
                break;
            }
            case ManageReposWVMessages.HELP: {
                vscode.window.showInformationMessage("More information about this page, or open a webpage, probably");
                // vscode.commands.executeCommand(Commands.VSC_OPEN, vscode.Uri.parse(LEARN_MORE_LINK));
                break;
            }
            case ManageReposWVMessages.REFRESH: {
                // vscode.window.showInformationMessage("Refreshed repository list");
                await refreshPage(connection);
                break;
            }
            default: {
                Log.e("Received unknown event from manage templates webview:", msg);
            }
        }
    }
    catch (err) {
        Log.e("Error processing message from manage templates webview", err);
        Log.e("Message was", msg);
    }
}

async function promptForNewRepo(): Promise<{ repoUrl: string, description: string } | undefined> {
    let repoUrl = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        placeHolder: "https://raw.githubusercontent.com/kabanero-io/codewind-templates/master/devfiles/index.json",
        prompt: "Enter the URL to your template repository's index file.",
        validateInput: validateRepoInput,
    });

    if (!repoUrl) {
        return undefined;
    }
    repoUrl = repoUrl.trim();

    let description = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        placeHolder: "My Templates",
        prompt: "Enter a description for this template repository",
    });
    if (!description) {
        description = "(No description)";
    }
    description = description.trim();

    return { repoUrl, description };
}

function validateRepoInput(input: string): string | undefined {
    let asUrl: URL | undefined;
    try {
        // We use URL instead of vscode.Uri because the latter appears to throw errors irregularly.
        asUrl = new URL(input);
    }
    catch (err) {
        // not a url
    }
    if (!asUrl || !asUrl.host || !asUrl.protocol.startsWith("http")) {
        return "The repository URL must be a valid http(s) URL.";
    }
    // I think users will commonly make this error so we can help them out here for common hosting services
    else if (asUrl.host.includes("github") && !asUrl.host.includes("raw")) {
        return getRawLinkMsg("GitHub");
    }
    else if (asUrl.host.includes("bitbucket") && !asUrl.pathname.includes("raw")) {
        return getRawLinkMsg("Bitbucket");
    }
    else if (asUrl.host.includes("gitlab") && !asUrl.pathname.includes("raw")) {
        return getRawLinkMsg("GitLab");
    }
    return undefined;
}

function getRawLinkMsg(provider: string): string {
    return `For ${provider} URLs, you must use the raw link.`;
}

async function fetchRepositoryList(connection: Connection): Promise<IRawTemplateRepo[]> {
    return Requester.get(EndpointUtil.resolveMCEndpoint(connection, MCEndpoints.TEMPLATE_REPOS));
}
