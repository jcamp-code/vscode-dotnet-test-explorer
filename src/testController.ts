import { rmdir } from 'fs/promises'
import { execFile } from 'child_process'
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from 'vscode'
import { Utility } from './utility'
import { parseTestName } from './parseTestName'
import { parseResults } from './testResultsFile'
import { buildTree, ITestTreeNode, mergeSingleItemTrees } from './buildTree'
import { TestCommands } from './testCommands'
import { IDiscoverTestsResult } from './testDiscovery'
import { basename } from 'path'
import { AppInsightsClient } from "./appInsightsClient";
import { StatusBar } from './statusBar'
import { TestNode } from './testNode';
import { ITestResult, TestResult } from './testResult';
import { Logger } from './logger';

export interface TestControllerExtended extends vscode.TestController {
  _onDidChangeTreeData: vscode.EventEmitter<any>
  onDidChangeTreeData: vscode.Event<any>
  testNodesMap: WeakMap<vscode.TestItem, TestNode>;
  testNodes: TestNode[];
  testResults: TestResult[];
  discoveredTests: string[];
  resultHandler: any;
}

export function createTestController(context: vscode.ExtensionContext, testCommands: TestCommands, statusBar: StatusBar): vscode.TestController {

  const controller = vscode.tests.createTestController('dotnet-test-explorer', 'Dot Net Tests') as TestControllerExtended

  // extend the VSC controller with additional properties
  controller._onDidChangeTreeData = new vscode.EventEmitter<any>();
  controller.onDidChangeTreeData = controller._onDidChangeTreeData.event;
  controller.testNodesMap = new WeakMap<vscode.TestItem, TestNode>();
  controller.testNodes = [];
  controller.testResults = [];
  controller.discoveredTests = [];
  controller.resultHandler = null;

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
   
   testCommands.onTestDiscoveryFinished(updateWithDiscoveredTests, controller);
   testCommands.onTestDiscoveryStarted(updateWithDiscoveringTest, controller);
   


    function buildItems() {
          const treeMode = Utility.getConfiguration().get<string>("treeMode");

          function createConcreteTree(parentNamespace: string, abstractTree: ITestTreeNode): TestNode {
      const children = [];
      for (const subNamespace of abstractTree.subTrees.values()) {
          children.push(createConcreteTree(abstractTree.fullName, subNamespace));
      }
      for (const test of abstractTree.tests) {
          const testNode = new TestNode(abstractTree.fullName, test, []);
          controller.testNodes.push(testNode);
          children.push(testNode);
      }
      return new TestNode(parentNamespace, abstractTree.name, [], children);
    }

          const parsedTestNames = controller.discoveredTests.map(parseTestName);    
    let tree = buildTree(parsedTestNames);

            if (treeMode === "merged") {
            tree = mergeSingleItemTrees(tree);
        }


    const concreteRoot = createConcreteTree("", tree);

    // have original tree for original explorer
    const generateItemFromNode = (tree: TestNode) => {
      const treeNode = controller.createTestItem(tree.fullName, tree.name)
      controller.testNodesMap.set(treeNode, tree);
      if (tree.children) {
        for (const subTree of tree.children) {
          treeNode.children.add(generateItemFromNode(subTree))
        }
      }
      
      return treeNode
    }
    const vsTestRoot = generateItemFromNode(concreteRoot)

      vsTestRoot.children.forEach((sub) => {
        controller.items.add(sub)
      })
        
  

    }

   
  function updateWithDiscoveringTest() {
  
    controller.items.replace([]);
    // update with settings
    controller._onDidChangeTreeData.fire(null);
  }

  function updateWithDiscoveredTests(results: IDiscoverTestsResult[]) {
    controller.items.replace([]);

    controller.testNodes = [];
    controller.discoveredTests = [].concat(...results.map((r) => r.testNames));
    buildItems()

  }

  function updateWithDiscoveredTestsFirstTry(results: IDiscoverTestsResult[]) {
    // const parsedTestNames = ...results.map((x) => parseTestName(x.trim()))
    // const rootTree = mergeSingleItemTrees(buildTree(parsedTestNames));
    // const rootTree = buildTree(parsedTestNames)

    controller.items.replace([]);

              // convert the tree into tests
          const generateItemFromNode = (tree: ITestTreeNode) => {
            const treeNode = controller.createTestItem(tree.fullName, tree.name)
            // controller.testNodesMap.set(treeNode, tree);

            for (const subTree of tree.subTrees.values()) {
              treeNode.children.add(generateItemFromNode(subTree))
            }
            for (const test of tree.tests) {
              const _fqn = Utility.getFqnTestName(tree.fullName + '.' + test).replace('+', '.')
              const childNode = controller.createTestItem(
                  tree.fullName + '.' + test,
                  test,
                  // vscode.Uri.parse(`command:dotnet-test-explorer.newGotoTest`) // doesn't work but need a uri to get icon to show, test extension expects a file / folder uri
                  vscode.Uri.parse(`vscdnte:${_fqn}`)
                )
                // controller.testNodesMap.set(childNode, tree.fullName);

              treeNode.children.add(childNode)
            }

            return treeNode
          }


    let count = 0
    results.forEach(element => {      
      const parsedTestNames = element.testNames.map((x) => parseTestName(x.trim()))
      const rootTree = buildTree(parsedTestNames)
      count += parsedTestNames.length
      const rootNode = generateItemFromNode(rootTree)
      controller.testNodesMap.set(rootNode, rootTree);
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
    function addTestResults(results: ITestResult) {

      const fullNamesForTestResults = results.testResults.map((r) => r.fullName);
      // controller.discoveredTests = []

      if (results.clearPreviousTestResults) {
          controller.discoveredTests = [...fullNamesForTestResults];
          // controller.testResults = null;
          buildItems()
          
      } else {
          const newTests = fullNamesForTestResults.filter((r) => controller.discoveredTests.indexOf(r) === -1);

          if (newTests.length > 0) {
              controller.discoveredTests.push(...newTests);
              buildItems()
              
          }
      }

      controller.discoveredTests = controller.discoveredTests.sort();

      statusBar.discovered(controller.discoveredTests.length);

      controller.testResults = results.testResults;

      if (controller.testResults) {

        function processResults(item: vscode.TestItem) {
          const result = results.testResults.find((tr) => tr.fullName === item.id);
          if (result) {
            Logger.Log(item.id)
            if (result.outcome === 'Failed') run.failed(item, { message: result.message })
            else if (result.outcome === 'NotExecuted') run.skipped(item)
            else if (result.outcome === 'Passed') run.passed(item)
            else console.log('unexpected value for outcome: ' + result.outcome)
          }

          item.children.forEach((child) => {
            processResults(child)
          })
        }

        controller.items.forEach((root) => {
          processResults(root)
        })
        
      }
// run.end()

//       statusBar.testRun(results.testResults);

      // this._onDidChangeTreeData.fire(null);
    }

   // if (controller.resultHandler === null) {
      //testCommands.onNewTestResults(addTestResults, controller);
     /// controller.resultHandler = true
 //   }
  
    const itemsToRun: vscode.TestItem[] = []

    const addItems = (item: vscode.TestItem) => {
      itemsToRun.push(item)
      // item.children.forEach((element) => {
      //   addItems(element)
      // })
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

    function startChildren(item: vscode.TestItem) {
      run.started(item)
      item.children.forEach((child => {
        startChildren(child)
      }))

    }
    
    //async mapping https://stackoverflow.com/questions/40140149/use-async-await-with-array-map
    const itemPromises =  itemsToRun.map(async (item) => {
      startChildren(item)
      const result = await testCommands.runTestByName(item.id, item.children.size == 0)
      if (result) addTestResults(result)
    })

    await Promise.all(itemPromises)

    run.end()


    const toBeJoined = [...excludeFilters]
    if (includeFilters) {
      toBeJoined.push('(' + includeFilters.join('|') + ')')
    }

    const joinedFilters = toBeJoined.join('&')

    const filterArgs = joinedFilters.length > 0 ? ['--filter', joinedFilters] : []
    const resultsFolder = fs.mkdtempSync(path.join(os.tmpdir(), "test-explorer"));
    const resultsFile = path.join(resultsFolder, 'test-results.trx')
    const loggerArgs = ['--logger', 'trx;LogFileName=' + resultsFile]
/*
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
    */
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
