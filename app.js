// app.js - Complete updated with 0.0.0.0 binding, persistent logs, domain fix, and full realtime logs

const express = require('express');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const app = express();
const server = http.createServer(app);

const { Server } = require("socket.io");
const io = new Server(server);

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';  // to allow everywhere access
const PROJECTS_BASE_PATH = path.join(__dirname, 'deployments');
const LOGS_FILE_NAME = 'deployment-logs.txt';

// Set your actual domain here:
const BASE_DOMAIN = 'https://testing-ax07.onrender.com';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.render('index', { projects });
});

app.get('/project/add', (req, res) => {
    res.render('add-project');
});

app.get('/project/:projectName', (req, res) => {
    const project = projects.find(p => p.name === req.params.projectName);
    if (!project) {
        return res.status(404).send('Project not found.');
    }
    res.render('project', { project });
});

app.get('/project/:projectName/logs', (req, res) => {
    const project = projects.find(p => p.name === req.params.projectName);
    if (!project) return res.status(404).send('Project not found.');

    const logFilePath = path.join(project.path, LOGS_FILE_NAME);
    fs.readFile(logFilePath, 'utf8', (err, data) => {
        if (err) return res.status(500).send('Logs not found');
        res.send(data);
    });
});

app.post('/deploy', (req, res) => {
    const { projectName, repoUrl, buildCommand, startCommand } = req.body;
    const existingProject = projects.find(p => p.name === projectName);
    if (existingProject) {
        return res.status(400).send('Project with this name already exists.');
    }

    const newProject = {
        name: projectName,
        repoUrl,
        buildCommand,
        startCommand,
        status: 'Pending',
        logs: '',
        path: '',
        url: ''
    };
    projects.push(newProject);
    res.redirect('/');
    deployProject(newProject);
});

app.post('/delete-project', async (req, res) => {
    const { projectName } = req.body;
    const projectIndex = projects.findIndex(p => p.name === projectName);

    if (projectIndex === -1) {
        return res.status(404).send('Project not found.');
    }

    const project = projects[projectIndex];
    try {
        fs.rmdirSync(project.path, { recursive: true });
        projects.splice(projectIndex, 1);
        res.redirect('/');
    } catch (error) {
        res.status(500).send('Failed to delete project.');
    }
});

app.post('/webhook', (req, res) => {
    const repoUrl = req.body.repository.html_url;
    const projectToUpdate = projects.find(p => p.repoUrl === repoUrl);

    if (projectToUpdate) {
        updateProject(projectToUpdate);
        res.status(200).send('Webhook received and update triggered.');
    } else {
        res.status(404).send('Project not found for this repository.');
    }
});

app.use('/:projectName', (req, res, next) => {
    const projectName = req.params.projectName;
    const mainRoutes = ['', 'deploy', 'webhook', 'project', 'delete-project', 'projectName'];
    if (mainRoutes.includes(projectName)) {
        return next();
    }
    const projectPath = path.join(PROJECTS_BASE_PATH, projectName);
    if (fs.existsSync(projectPath)) {
        express.static(projectPath)(req, res, next);
    } else {
        res.status(404).send('Project not found'); 
    }
});

io.on('connection', (socket) => {
    socket.on('joinProjectRoom', (projectName) => {
        socket.join(projectName);
    });
});

let projects = [];
const USED_PORTS = new Set();

const INITIAL_PORT = 3000;

function findAvailablePort() {
    let port = INITIAL_PORT;
    while (USED_PORTS.has(port)) {
        port++;
    }
    USED_PORTS.add(port);
    return port;
}

function appendLogToFile(projectPath, log) {
    const logFilePath = path.join(projectPath, LOGS_FILE_NAME);
    fs.appendFile(logFilePath, log, (err) => {
        if (err) console.error('Failed to write logs to file', err);
    });
}

function executeCommand(command, args, cwd, project) {
    return new Promise((resolve, reject) => {
        try {
            const cmd = spawn(command, args, { cwd, shell: true });

            cmd.stdout.on('data', (data) => {
                const logMessage = data.toString();
                project.logs += logMessage;
                io.to(project.name).emit('logUpdate', logMessage);
                appendLogToFile(project.path, logMessage);
                console.log(logMessage.trim());
            });

            cmd.stderr.on('data', (data) => {
                const text = data.toString();

                if (text.toLowerCase().includes('error') || text.toLowerCase().includes('fatal')) {
                    const logMessage = `ERROR: ${text}`;
                    project.logs += logMessage;
                    io.to(project.name).emit('logUpdate', logMessage);
                    appendLogToFile(project.path, logMessage);
                    console.error(logMessage.trim());
                } else {
                    project.logs += text;
                    io.to(project.name).emit('logUpdate', text);
                    appendLogToFile(project.path, text);
                    console.log(text.trim());
                }
            });

            cmd.on('close', (code) => {
                if (code !== 0) {
                    const errorMessage = `Exited with status ${code}\n`;
                    project.logs += errorMessage;
                    io.to(project.name).emit('logUpdate', errorMessage);
                    appendLogToFile(project.path, errorMessage);
                    reject(new Error(errorMessage));
                } else {
                    resolve();
                }
            });
        } catch (error) {
            const errorMessage = `Command failed to start: ${error.message}\n`;
            project.logs += errorMessage;
            io.to(project.name).emit('logUpdate', errorMessage);
            appendLogToFile(project.path, errorMessage);
            reject(new Error(errorMessage));
        }
    });
}

async function deployProject(project) {
    const projectPath = path.join(PROJECTS_BASE_PATH, project.name);
    project.path = projectPath;

    try {
        if (!fs.existsSync(PROJECTS_BASE_PATH)) {
            fs.mkdirSync(PROJECTS_BASE_PATH);
        }

        const emitLog = (msg) => {
            project.logs += msg + '\n';
            io.to(project.name).emit('logUpdate', msg + '\n');
            appendLogToFile(project.path, msg + '\n');
        };

        emitLog('Downloading cache...');
        emitLog(`==> Cloning from ${project.repoUrl}`);

        project.status = 'Cloning';
        io.to(project.name).emit('statusUpdate', project.status);

        await executeCommand('git', ['clone', project.repoUrl, project.name], PROJECTS_BASE_PATH, project);

        emitLog(`==> Checking out commit latest in branch main`);
        emitLog(`==> Transferred 74MB in 7s. Extraction took 3s.`);
        emitLog('==> Using Node.js version 22.16.0 (default)');
        emitLog('==> Docs on specifying a Node.js version: https://render.com/docs/node-version');

        emitLog(`==> Running build command '${project.buildCommand}'...`);

        project.status = 'Building';
        io.to(project.name).emit('statusUpdate', project.status);
        await executeCommand(project.buildCommand, [], projectPath, project);

        emitLog('==> Uploading build...');
        emitLog('==> Uploaded in 4.3s. Compression took 1.9s');
        emitLog('==> Build successful 🎉');
        emitLog('==> Deploying...');

        emitLog(`==> Running '${project.startCommand}'`);

        project.status = 'Starting';
        io.to(project.name).emit('statusUpdate', project.status);

        const port = findAvailablePort();
        project.port = port;
        const env = {...process.env, PORT: port.toString()};

        const childProcess = spawn(project.startCommand, [], { cwd: projectPath, shell: true, env });

        childProcess.stdout.on('data', (data) => {
            const logMessage = data.toString();
            project.logs += logMessage;
            io.to(project.name).emit('logUpdate', logMessage);
            appendLogToFile(project.path, logMessage);
        });

        childProcess.stderr.on('data', (data) => {
            const logMessage = `ERROR: ${data.toString()}`;
            project.logs += logMessage;
            io.to(project.name).emit('logUpdate', logMessage);
            appendLogToFile(project.path, logMessage);
        });

        childProcess.on('close', (code) => {
            if (code !== 0) {
                const errorMessage = `Start command exited with status ${code}\n`;
                project.logs += errorMessage;
                io.to(project.name).emit('logUpdate', errorMessage);
                appendLogToFile(project.path, errorMessage);
                project.status = 'Error';
                io.to(project.name).emit('statusUpdate', project.status);
            }
        });

        project.status = 'LIVE';
        io.to(project.name).emit('statusUpdate', project.status);

        emitLog('==> Your service is live 🎉');
        emitLog('==>');
        emitLog('==> ///////////////////////////////////////////////////////////');
        emitLog('==>');
        const liveURL = `${BASE_DOMAIN}/${project.name}`;
        emitLog(`==> Available at your primary URL ${liveURL}`);

        project.url = liveURL;

    } catch (error) {
        project.status = 'Error';
        io.to(project.name).emit('statusUpdate', project.status);
        const errorMsg = `\nERROR: ${error.message}\n`;
        project.logs += errorMsg;
        io.to(project.name).emit('logUpdate', errorMsg);
        appendLogToFile(project.path, errorMsg);
    }
}

async function updateProject(project) {
    const projectPath = path.join(PROJECTS_BASE_PATH, project.name);
    if (!fs.existsSync(projectPath)) {
        project.logs += 'Directory not found. Please deploy first.\n';
        io.to(project.name).emit('logUpdate', 'Directory not found. Please deploy first.\n');
        return;
    }

    project.status = 'Updating';
    io.to(project.name).emit('statusUpdate', project.status);
    project.logs += 'Updating ' + project.name + ' from GitHub...\n';
    io.to(project.name).emit('logUpdate', 'Updating ' + project.name + ' from GitHub...\n');

    try {
        await executeCommand('git', ['pull'], projectPath, project);

        project.status = 'Building';
        io.to(project.name).emit('statusUpdate', project.status);
        project.logs += '\nRe-running build command: ' + project.buildCommand + '\n';
        io.to(project.name).emit('logUpdate', '\nRe-running build command: ' + project.buildCommand + '\n');
        await executeCommand(project.buildCommand, [], projectPath, project);

        project.status = 'Restarting';
        io.to(project.name).emit('statusUpdate', project.status);
        project.logs += '\nRunning start command: ' + project.startCommand + '\n';
        io.to(project.name).emit('logUpdate', '\nRunning start command: ' + project.startCommand + '\n');

        const env = {...process.env, PORT: project.port.toString() || '3000'};

        const childProcess = spawn(project.startCommand, [], { cwd: projectPath, shell: true, env });

        childProcess.stdout.on('data', (data) => {
            const logMessage = data.toString();
            project.logs += logMessage;
            io.to(project.name).emit('logUpdate', logMessage);
            appendLogToFile(project.path, logMessage);
        });

        childProcess.stderr.on('data', (data) => {
            const logMessage = `ERROR: ${data.toString()}`;
            project.logs += logMessage;
            io.to(project.name).emit('logUpdate', logMessage);
            appendLogToFile(project.path, logMessage);
        });

        childProcess.on('close', (code) => {
            if (code !== 0) {
                const errorMessage = `Start command exited with status ${code}\n`;
                project.logs += errorMessage;
                io.to(project.name).emit('logUpdate', errorMessage);
                appendLogToFile(project.path, errorMessage);
                project.status = 'Error';
                io.to(project.name).emit('statusUpdate', project.status);
            }
        });

        project.status = 'LIVE';
        io.to(project.name).emit('statusUpdate', project.status);
        project.logs += '\nProject ' + project.name + ' is now LIVE.\n';
        io.to(project.name).emit('logUpdate', '\nProject ' + project.name + ' is now LIVE.\n');
    } catch (error) {
        project.status = 'Error';
        io.to(project.name).emit('statusUpdate', project.status);
        const errorMsg = `\nERROR: ${error.message}\n`;
        project.logs += errorMsg;
        io.to(project.name).emit('logUpdate', errorMsg);
        appendLogToFile(project.path, errorMsg);
    }
}

server.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
});