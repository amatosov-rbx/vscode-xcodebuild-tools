'use strict';

import * as path from 'path';
import * as child_process from 'child_process';

import * as ajv from 'ajv';
import * as vscode from 'vscode';

import * as util from './util';
import * as expander from './expand';
import * as diagnostics from './diagnostics';
import * as status from './status';

interface TaskConfiguration
{
    name: string;
    program: string;
    args: string[];
    cwd: string;
}

interface Configuration
{
    sdk: string;
    workspace: string;
    scheme: string;
    variables: Map<string,string>;
    args: string[];
    env: Map<string,string>;
    preBuildTasks: TaskConfiguration[];
    postBuildTasks: TaskConfiguration[];
    debugConfigurations: TaskConfiguration[];
}

const DefaultConfiguration : Configuration = 
{
    sdk: null,
    workspace: null,
    scheme: null,
    variables: new Map<string, string>(),
    args: [],
    env: new Map<string, string>(),
    preBuildTasks: [],
    postBuildTasks: [],
    debugConfigurations: []
};

const BuildConfigurations: string[] = [
    "Debug",
    "Profile",
    "Release"
];

enum BuildState
{
    IDLE,
    STARTED,
    KILLED
}

interface SpawnOptions
{
    program: string;
    args: string[];
    cwd?: string;
    env?: Map<string, string>;

    channel: vscode.OutputChannel;
    initChannel?: boolean;
    
    message?: string;
    parseOutput?: boolean;
}

function expand(e:expander.Expander, opts: SpawnOptions) : SpawnOptions
{
    return {
        program: e.expand(opts.program),
        args: e.expand(opts.args),
        cwd: e.expand(opts.cwd),
        env: e.expand(opts.env),

        channel: opts.channel,
        initChannel: opts.initChannel,
        
        message: e.expand(opts.message),
        parseOutput: opts.parseOutput
    };
}

class Extension
{
    private schemaPath = 
        path.join(this.context.extensionPath, "schemas", "xcodebuild-tools-schema.json");

    private readonly configFilePath :string = 
        path.join(vscode.workspace.rootPath, ".vscode", "xcodebuild-tools.json");
    
    private readonly statusBar = 
        new status.StatusBar();

    private diag : vscode.DiagnosticCollection = 
        vscode.languages.createDiagnosticCollection('xcodebuild-tools');

    private buildOutputChannel = 
        vscode.window.createOutputChannel("xcodebuild-tools build");

    private runOutputChannel = 
        vscode.window.createOutputChannel("xcodebuild-tools run");

    private allConfigs : Configuration[] = [];

    private addDisposable(d: vscode.Disposable) : void
    {
        this.context.subscriptions.push(d);
    }

    public constructor(private context: vscode.ExtensionContext)
    {
        const commandNames = [
            'build', 
            'clean', 
            'debug',
            'profile',
            'run', 
            'kill', 
            'selectConfiguration', 
            'selectBuildConfiguration', 
            'selectDebugConfiguration',
            "openXcode"
        ];

        for( let name of commandNames)
        {
            context.subscriptions.push( vscode.commands.registerCommand(`xcodebuild-tools.${name}`, ()=> 
            {
                if( !vscode.workspace.registerTextDocumentContentProvider )
                {
                    vscode.window.showErrorMessage('Extension [xcodebuild-tools] requires an open folder');
                    return;
                }
                else if( !this.config )
                {
                    vscode.window.showErrorMessage('Extension [xcodebuild-tools] requires a correctly formatted .vscode/xcodebuild-tools.json');
                    return;
                }
                else
                {
                    this[name]();
                }
            }));
        }

        const configWatcher = vscode.workspace.createFileSystemWatcher(this.configFilePath);
        this.addDisposable( configWatcher );

        this.addDisposable( configWatcher.onDidCreate((uri : vscode.Uri) => this.reloadConfig(uri.fsPath)) );
        this.addDisposable( configWatcher.onDidChange((uri : vscode.Uri) => this.reloadConfig(uri.fsPath)) );
        this.addDisposable( configWatcher.onDidDelete((uri : vscode.Uri) => this.reloadConfig(uri.fsPath)) );

        this.addDisposable( this.statusBar );
        this.addDisposable( this.diag );
        this.addDisposable( this.buildOutputChannel );
        this.addDisposable( this.runOutputChannel );
    }

    private validateConfig : ajv.ValidateFunction;

    public async setup()
    {
        this.validateConfig = await util.readSchema(this.schemaPath);
        await this.reloadConfig(this.configFilePath);
    }

    private async reloadConfig(fileName: string)
    {
        try
        {
            let configFromJson = await util.readJSON(fileName, this.validateConfig);

            if (Array.isArray(configFromJson))
            {
                let configs: Configuration[] = []
                for (let config of configFromJson) {
                    configs.push(this.processConfig(config))  ;
                }
                this.allConfigs = configs;
            }
            else
            {
                this.allConfigs = [this.processConfig(configFromJson)];
            }
        }
        catch(e)
        {
            this.allConfigs = [];

            vscode.window.showErrorMessage(`[xcodebuild-tools]: ${e.message}`);
        }

        this.updateStatus();
    }

    private processConfig(config: Configuration)
    {
        if( config.variables )
        {
            config.variables = new Map<string, string>(util.entries(config.variables));
        }

        if( config.env )
        {
            config.env = new Map<string, string>(util.entries(config.env));
        }

        return util.merge(DefaultConfiguration, config);
    }

    private getState<T>(
        key: string, 
        legal:(val:T)=>boolean, 
        otherwise:(key:string)=>T)
    {
        let val = this.context.workspaceState.get<T>(key);

        if( ! val || !legal(val) )
        {
            val = otherwise(key);
            this.context.workspaceState.update(key, val);
        }

        return val;
    }

    get activeConfigIndex() : number
    {
        return this.getState<number>(
            "activeConfigIndex", 
            (val:number) => val >= 0 && val < this.allConfigs.length,
            (_:string) => 0
        );
    }

    set activeConfigIndex(configIndex: number)
    {
        this.context.workspaceState.update("activeConfigIndex", configIndex);
        this.updateStatus();
    }

    get config() : Configuration
    {
        if (this.activeConfigIndex >= 0 && this.activeConfigIndex < this.allConfigs.length)
        {
            return this.allConfigs[this.activeConfigIndex];
        }
        return null;
    }

    get activeConfigName() : string
    {
        return this.configurationName(this.config) || "Not configured"
    }

    get configurationNames() : string[]
    {
        return this.allConfigs.map((config) => this.configurationName(config));
    }

    private configurationName(config: Configuration) : string
    {
        if (config)
        {
            let e = this.configExpander(config)
            return e.expand(path.basename(config.workspace, ".xcworkspace") + " | " + config.scheme)
        }
        return null
    }

    get buildConfig() : string
    {
        return this.buildConfigFor(this.activeConfigName)
    }

    private buildConfigFor(configName: string) : string
    {
        return this.getState<string>(
            this.buildConfigKey(configName), 
            (val:string) => BuildConfigurations.indexOf(val)!==-1, 
            (key:string) => BuildConfigurations[0]
        );
    }

    set buildConfig(config: string)
    {
        this.context.workspaceState.update(this.buildConfigKey(), config);
        this.updateStatus();
    }
    
    private buildConfigKey(configName = this.activeConfigName) : string
    {
        return "buildConfig" + configName
    }

    get debugConfigName() : string
    {
        return this.getState<string>(
            this.debugConfigNameKey, 
            (val:string) => this.config.debugConfigurations.find( dc => dc.name===val ) !== undefined, 
            (key:string) => this.config.debugConfigurations.length > 0 ? this.config.debugConfigurations[0].name : null
        );
    }

    set debugConfigName(config: string)
    {
        this.context.workspaceState.update(this.debugConfigNameKey, config);
        this.updateStatus();
    }
    
    get debugConfigNameKey() : string
    {
        return "debugConfig" + this.activeConfigName
    }

    get debugConfig() : TaskConfiguration
    {
        let name = this.debugConfigName;
        return this.config.debugConfigurations.find( dc => dc.name===name );
    }

    private updateStatus()
    {
        if( this.config )
        {
            let e = this.expander();
            this.statusBar.update(this.activeConfigName, e.expand(this.buildConfig), e.expand(this.debugConfigName));
        }
        else
        {
            this.statusBar.hide();
        }        
    }

    private expander(config : Configuration = this.config) : expander.Expander
    {
        const M = this.configExpanderMap(config);

        M.set('buildConfig', this.buildConfigFor(this.configurationName(config)));

        return new expander.Expander(M);
    }

    private configExpander(config : Configuration) : expander.Expander
    {
        const M = this.configExpanderMap(config);

        return new expander.Expander(M);
    }

    private configExpanderMap(config : Configuration):  Map<string, string>
    {
        const M = new Map<string, string>();

        M.set('workspaceRoot', vscode.workspace.rootPath);
        M.set('buildRoot', '${workspaceRoot}/build');
        M.set('buildPath', '${buildRoot}/${buildConfig}');

        for( let [v, val] of config.variables )
        {
            M.set(v, val);
        }

        return M
    }

    private buildState : BuildState = BuildState.IDLE;
    private buildProcess : child_process.ChildProcess = null;

    private spawn(args:SpawnOptions) : child_process.ChildProcess
    {
        let proc = util.spawn(args.program, args.args, args.cwd, args.env);
        this.buildProcess = proc;

        util.redirectToChannel(proc, args.channel, args.initChannel);
        
        if( args.parseOutput )
        {
            diagnostics.parseOutput(this.diag, proc.stdout);
        }

        if( args.message )
        {
            args.channel.appendLine(`[xcodebuild-tools]: ${args.message}`);
        }

        args.channel.appendLine(`[xcodebuild-tools]: Running: ${args.program} ${args.args.join(" ")}`);

        if( args.cwd )
        {
            args.channel.appendLine(`[xcodebuild-tools]: Working Directory: ${args.cwd}`);
        }

        proc.on('terminated', (message:string) => 
        {
            this.buildProcess = null;
            args.channel.appendLine(`[xcodebuild-tools]: ${message}`);
        });

        return proc;
    }

    private async asyncSpawn(args:SpawnOptions)
    {
        return new Promise<child_process.ChildProcess>((resolve, reject) => 
        {
            let proc = this.spawn(args);

            proc.on('fail', (message:string) => 
            {
                if( this.buildState === BuildState.STARTED )
                {
                    reject(new Error(message));
                }
                else
                {
                    resolve(proc);
                }
            });

            proc.on('success', (message:string) => 
            {
                resolve(proc);
            });
        });
    }

    private async asyncSpawnXcodebuild(e:expander.Expander, extraArgs:string[]) : Promise<child_process.ChildProcess>
    {
        let args = [
            "-workspace", this.config.workspace, 
            "-scheme", this.config.scheme, 
            "-configuration", this.buildConfig,
            ...this.config.args
        ];

        if( this.config.sdk )
        {
            args.push("-sdk", this.config.sdk);
        }

        args.push("CONFIGURATION_BUILD_DIR=${buildPath}");

        let opts: SpawnOptions= {
            program: "xcodebuild",
            args: args.concat(extraArgs),
            env: this.config.env,
            channel: this.buildOutputChannel,
            initChannel: false,
            parseOutput: true
        };

        return await this.asyncSpawn(expand(e, opts));
    }

    private async asyncSpawnTask(e:expander.Expander, task: TaskConfiguration) : Promise<child_process.ChildProcess>
    {
        let args: SpawnOptions =
        {
            program: task.program,
            args: task.args,
            cwd: task.cwd,
            env: this.config.env,            
            channel: this.buildOutputChannel,
            initChannel: false,
            message: `Runnning Task: ${task.name}`
        };

        return await this.asyncSpawn(expand(e, args));
    }

    private async wrapBuild<T>( f: () => T ) : Promise<T|null>
    {
        vscode.workspace.saveAll();

        if( this.buildState !== BuildState.IDLE )
        {
            return null;
        }

        this.buildState = BuildState.STARTED;

        try
        {
            return await f();
        }
        catch(e)
        {
        }
        finally
        {
            this.buildState = BuildState.IDLE;
        }
    }

    private async asyncBuild(e:expander.Expander)
    {
        this.buildOutputChannel.clear();
        this.buildOutputChannel.show();

        for( let task of this.config.preBuildTasks )
        {
            await this.asyncSpawnTask(e, task);
        }
        
        await this.asyncSpawnXcodebuild(e, []);

        for( let task of this.config.postBuildTasks )
        {
            await this.asyncSpawnTask(e, task);
        }
    }

    public async build()
    {
        const e = this.expander();

        await this.wrapBuild( async () => 
        {
            await this.asyncBuild(e);
        });
    }

    public async clean()
    {
        const e = this.expander();

        await this.wrapBuild( async () => 
        {
            await this.asyncSpawnXcodebuild(e, ['clean']);
        });
    }

    public async debug()
    {
        await this.wrapBuild( async () => 
        {
            const e = this.expander();

            await this.asyncBuild(e);
        
            const dc = this.debugConfig;

            const config = {
                name: e.expand(dc.name),
                program:  e.expand(dc.program),
                args:  e.expand(dc.args),
                cwd:  e.expand(dc.cwd),
                type: "cppdbg",
                request: "launch",
                stopAtEntry: false,
                environment: [],
                externalConsole: false,
                MIMode: "lldb"
            };

            await vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], config);
        });
    }

    public async profile()
    {
        await this.wrapBuild( async () => 
        {
            const e = this.expander();

            await this.asyncBuild(e);
        
            const dc = this.debugConfig;
            
            let proc = util.spawn(
                "instruments",
                [
                    "-t", "Time Profiler",
                    e.expand(dc.program)
                ].concat(e.expand(dc.args)), 
                e.expand(dc.cwd)
            );

            util.redirectToChannel(proc, this.runOutputChannel, true);

            this.runOutputChannel.appendLine(
                `[xcodebuild-tools] Running: instruments -t "Time Profiler" ${e.expand(dc.program)} ${e.expand(dc.args)}`
            );

            proc.on('terminated', (message:string) => 
            {
                this.runOutputChannel.append(`[xcodebuild-tools] ${message}`);
            });
        });
    }

    public async run()
    {
        await this.wrapBuild( async () => 
        {
            const e = this.expander();

            await this.asyncBuild(e);
        
            const dc = this.debugConfig;
            let proc = util.spawn(e.expand(dc.program), e.expand(dc.args), e.expand(dc.cwd));

            util.redirectToChannel(proc, this.runOutputChannel, true);

            proc.on('terminated', (message:string) => 
            {
                this.runOutputChannel.append(`[xcodebuild-tools] ${message}`);
            });
        });
    }

    public kill()
    {
        if( this.buildState === BuildState.STARTED && this.buildProcess !== null )
        {
            this.buildState = BuildState.KILLED;
            this.buildProcess.kill("SIGTERM");
        }
    }

    public async selectConfiguration()
    {
        let configNames: vscode.QuickPickItem[] = this.allConfigs.map((config: Configuration, index: number) => {
            let e = this.configExpander(config)
            let workspacePath = path.relative(vscode.workspace.rootPath, e.expand(config.workspace))
            return {
                label: e.expand(config.scheme),
                description: workspacePath + (index == this.activeConfigIndex ? " (active)" : "")
            }
        });
        let choice = await vscode.window.showQuickPick(configNames);
        
        if( choice )
        {
            this.activeConfigIndex = configNames.indexOf(choice)
        }
    }

    public async selectBuildConfiguration()
    {
        let choice = await vscode.window.showQuickPick(BuildConfigurations);
        
        if( choice )
        {
            this.buildConfig = choice;
        }
    }

    public async selectDebugConfiguration()
    {
        let e = this.expander()
        let items = this.config.debugConfigurations.map( dc => e.expand(dc.name) );

        if ( items.length > 0 )
        {
            let choice = await vscode.window.showQuickPick(items);
            
            if( choice )
            {
                this.debugConfigName = choice;
            }
        }
    }

    public openXcode() 
    {
        const e = this.expander();
        util.spawn('open', [e.expand(this.config.workspace)], null);
    }
}

export async function activate(context: vscode.ExtensionContext) 
{
    let ext = new Extension(context);
    await ext.setup();
}

export function deactivate() 
{
}
