import { rmdir } from 'fs/promises'
import { execFile } from 'child_process'
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from 'vscode'
import { Utility } from './utility'
import { parseTestName } from './parseTestName'
import { parseResults } from './testResultsFile'
import { buildTree, ITestTreeNode } from './buildTree'
import { TestCommands } from './testCommands'
import { IDiscoverTestsResult } from './testDiscovery'
import { basename } from 'path'
import { AppInsightsClient } from "./appInsightsClient";
import { StatusBar } from './statusBar'

export interface TestControllerExtended extends vscode.TestController {
  _onDidChangeTreeData: vscode.EventEmitter<any>
  onDidChangeTreeData: vscode.Event<any>
}

export function createTestController(context: vscode.ExtensionContext, testCommands: TestCommands, statusBar: StatusBar): vscode.TestController {

  const controller = vscode.tests.createTestController('dotnet-test-explorer', 'Dot Net Tests') as TestControllerExtended

  // extend the VSC controller with additional properties
  controller._onDidChangeTreeData = new vscode.EventEmitter<any>();
  controller.onDidChangeTreeData = controller._onDidChangeTreeData.event;

  // https://github.com/microsoft/vscode/blob/b7d5b65a13299083e92bca91be8fa1289e95d5c1/src/vs/workbench/contrib/testing/browser/testing.contribution.ts
  // https://github.com/microsoft/vscode/blob/c11dabf9ce669f599a18d7485d397834abc1c8e1/src/vs/workbench/api/common/extHostTesting.ts - controller
  const commandHandler = async (extId: string) => {
    try {
      const parts = extId.split('\0')

      let current = controller.items.get(parts[1])

      for (let x = 2; x < parts.length; x++) {
        current = current.children.get(parts[x])
      }

      // should be left with desired testitem as current
      if (current && current.id) {
        vscode.commands.executeCommand('dotnet-test-explorer.gotoTest', {
          fqn: Utility.getFqnTestName(current.id).replace('+', '.'),
        })
      }
    } catch {}
  }
  context.subscriptions.push(vscode.commands.registerCommand('vscode.revealTest', commandHandler))
  
   testCommands.onTestDiscoveryFinished(updateWithDiscoveredTests, this);
   testCommands.onTestDiscoveryStarted(updateWithDiscoveringTest, this);
  function updateWithDiscoveringTest() {
  
    controller.items.replace([]);
    // update with settings
    controller._onDidChangeTreeData.fire(null);
  }

  function updateWithDiscoveredTests(results: IDiscoverTestsResult[]) {
    // const parsedTestNames = ...results.map((x) => parseTestName(x.trim()))
    // const rootTree = mergeSingleItemTrees(buildTree(parsedTestNames));
    // const rootTree = buildTree(parsedTestNames)

    controller.items.replace([]);

              // convert the tree into tests
          const generateNode = (tree: ITestTreeNode) => {
            const treeNode = controller.createTestItem(tree.fullName, tree.name)
            for (const subTree of tree.subTrees.values()) {
              treeNode.children.add(generateNode(subTree))
            }
            for (const test of tree.tests) {
              const _fqn = Utility.getFqnTestName(tree.fullName + '.' + test).replace('+', '.')
              treeNode.children.add(
                controller.createTestItem(
                  tree.fullName + '.' + test,
                  test,
                  // vscode.Uri.parse(`command:dotnet-test-explorer.newGotoTest`) // doesn't work but need a uri to get icon to show, test extension expects a file / folder uri
                  vscode.Uri.parse(`vscdnte:${_fqn}`)
                )
              )
            }

            return treeNode
          }


    let count = 0
    results.forEach(element => {      
      const parsedTestNames = element.testNames.map((x) => parseTestName(x.trim()))
      const rootTree = buildTree(parsedTestNames)
      count += parsedTestNames.length
      const rootNode = generateNode(rootTree)
      rootNode.label = basename(element.folder)
      controller.items.add(rootNode)

    });

    // change to use settings
    statusBar.discovered(count);
    controller._onDidChangeTreeData.fire(null);
  }

  
  controller.refreshHandler = async (token) => {
    await testCommands.discoverTests();
    AppInsightsClient.sendEvent("refreshTestExplorer");
  }

  controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, async (request, token) => {
    const run = controller.createTestRun(request, 'My test run', true)
    const wait = () => new Promise((resolve) => setTimeout(resolve, 1000))
  
    const itemsToRun: vscode.TestItem[] = []

    const addItems = (item: vscode.TestItem) => {
      itemsToRun.push(item)
      item.children.forEach((element) => {
        addItems(element)
      })
    }
    const removeItems = (item: vscode.TestItem) => {
      if (itemsToRun.includes(item)) 
        itemsToRun.splice(itemsToRun.indexOf(item), 1)

      item.children.forEach((element) => {
        removeItems(element)
      })
    }
    const createFilterArg = (item: vscode.TestItem, negate: boolean) => {
      const fullMatch = item.children.size === 0
      const operator = (negate ? '!' : '') + (fullMatch ? '=' : '~')
      const fullyQualifiedName = item.id.replaceAll(/\(.*\)/g, '')
      if (!negate) addItems(item)
      if (negate) removeItems(item)
      return `FullyQualifiedName${operator}${fullyQualifiedName}`
    }

    const includeFilters = request.include?.map((item) => createFilterArg(item, false))
    const excludeFilters = request.exclude.map((item) => createFilterArg(item, true))

    itemsToRun.map((item) => run.started(item))

    const toBeJoined = [...excludeFilters]
    if (includeFilters) {
      toBeJoined.push('(' + includeFilters.join('|') + ')')
    }

    const joinedFilters = toBeJoined.join('&')

    const filterArgs = joinedFilters.length > 0 ? ['--filter', joinedFilters] : []
    const resultsFolder = fs.mkdtempSync(path.join(os.tmpdir(), "test-explorer"));
    const resultsFile = path.join(resultsFolder, 'test-results.trx')
    const loggerArgs = ['--logger', 'trx;LogFileName=' + resultsFile]

    try {
      const env = {
        ...process.env,
        DOTNET_CLI_UI_LANGUAGE: 'en',
        VSTEST_HOST_DEBUG: '0',
      }

      const output = await new Promise((resolve, reject) =>
        execFile(
          'dotnet',
          ['test', ...filterArgs, ...loggerArgs],
          {
            env,
            cwd: vscode.workspace.workspaceFolders[0].uri.fsPath,
          },
          (error, stdOut, stdErr) => {
            // if (error) reject(error);
            // else
            resolve(stdOut)
          }
        )
      )

      const results = await parseResults(resultsFile)

      for (const result of results) {
        const parsedName = parseTestName(result.fullName)
        let item = controller.items.get('')
        for (const segment of parsedName.segments) {
          const segmentString = parsedName.fullName.substring(0, segment.end)
          item = item.children.get(segmentString)
          if (item === undefined) {
            // TODO: need to unfold folded items
            console.error('no such test node:', result.fullName, result)
            console.error('error at:', segmentString)
          }
        }
        if (item === undefined) {
          console.error('no such test:', result.fullName, result)
        }
        if (result.outcome === 'Failed') run.failed(item, { message: result.message })
        else if (result.outcome === 'NotExecuted') run.skipped(item)
        else if (result.outcome === 'Passed') run.passed(item)
        else console.log('unexpected value for outcome: ' + result.outcome)
      }
      run.end()
    } finally {
      // await unlink(resultsFile);
      await rmdir(resultsFolder)
    }
  })

  controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, async (request, token) => {
    const run = controller.createTestRun(request, 'My test run', true)
    const wait = () => new Promise((resolve) => setTimeout(resolve, 1000))

    let tests = request.include ?? controller.items
    tests.forEach((test) => {
      run.enqueued(test)
    })
    await wait()
    tests.forEach((test) => {
      run.started(test)
    })
    await wait()
    tests.forEach((test) => {
      run.passed(test)
    })
    run.end()
  })

  controller.createRunProfile('Watch', vscode.TestRunProfileKind.Run, async (request, token) => {
    const run = controller.createTestRun(request, 'My test run', true)
    const wait = () => new Promise((resolve) => setTimeout(resolve, 100))

    let tests = request.include ?? controller.items
    while (!token.isCancellationRequested) {
      tests.forEach((test) => {
        run.enqueued(test)
      })
      await wait()
      tests.forEach((test) => {
        run.started(test)
      })
      await wait()
      tests.forEach((test) => {
        run.passed(test)
      })
      await wait()
    }
    run.end()
  })

  return controller;
}
