const express = require('express');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3001;
const DEPLOYMENTS_DIR = path.join(__dirname, 'deployments');

// Create a directory to store cloned repos
if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    fs.mkdirSync(DEPLOYMENTS_DIR);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// A simple in-memory database to store project info
const projects = {};

// Root route to serve the EJS view
app.get('/', (req, res) => {
    res.render('index', { projects: Object.values(projects) });
});

// Route to handle new project submissions
app.post('/deploy', (req, res) => {
    const { repoUrl, buildCommand, startCommand, projectName } = req.body;
    
    // Validate required fields
    if (!repoUrl || !buildCommand || !startCommand || !projectName) {
        return res.status(400).send('Sabhi fields bharna zaroori hai.');
    }

    const repoName = projectName.toLowerCase().replace(/\s/g, '-');
    const repoPath = path.join(DEPLOYMENTS_DIR, repoName);

    if (projects[repoName]) {
        return res.status(409).send('Yeh project naam pehle se hi exist karta hai. Koi doosra naam chunein.');
    }

    // Save project info
    projects[repoName] = {
        name: projectName,
        url: repoUrl,
        path: repoPath,
        buildCommand: buildCommand,
        startCommand: startCommand,
        status: 'Cloning...',
        logs: 'Deployment shuru ho rahi hai...'
    };
    
    // Send a response immediately so the client doesn't time out
    res.redirect('/');

    // Start the deployment process asynchronously
    deployProject(repoName);
});

async function deployProject(repoName) {
    const project = projects[repoName];
    const { url, path: repoPath, buildCommand, startCommand } = project;

    try {
        // Step 1: Clone the repository
        console.log(`Cloning ${url} to ${repoPath}...`);
        project.status = 'Cloning...';
        project.logs += '\nCloning repository...';
        await executeCommand(`git clone ${url} ${repoPath}`);

        // Step 2: Run the build command
        console.log(`Running build command: ${buildCommand}`);
        project.status = 'Building...';
        project.logs += '\nRepository cloned. Ab build kar rahe hain...';
        await executeCommand(buildCommand, { cwd: repoPath });

        // Step 3: Start the app with PM2
        console.log(`Starting app with PM2: ${startCommand}`);
        project.status = 'Starting...';
        project.logs += '\nBuild complete. App shuru kar rahe hain...';
        const pm2StartCommand = `pm2 start ${startCommand} --name ${repoName} --cwd ${repoPath}`;
        await executeCommand(pm2StartCommand);

        project.status = 'Live';
        project.logs += `\nApp successfully started and is LIVE.`;
        console.log(`Project ${repoName} is now LIVE.`);

    } catch (error) {
        project.status = 'Error';
        project.logs += `\nERROR: ${error.message}`;
        console.error(`Deployment failed for ${repoName}:`, error);
    }
}

// Route to handle GitHub webhooks for updates
app.post('/webhook', (req, res) => {
    const { repository } = req.body;
    if (!repository) {
        return res.status(400).send('Invalid webhook payload.');
    }

    const repoUrl = repository.clone_url;
    
    // Find the project that matches the repo URL
    const project = Object.values(projects).find(p => p.url === repoUrl);
    
    if (!project) {
        return res.status(404).send('Project not found.');
    }

    // Acknowledge the webhook
    res.status(200).send('Webhook received. Updating project...');

    // Asynchronously pull and restart the app
    updateProject(project);
});

async function updateProject(project) {
    console.log(`Updating project ${project.name} from a new commit.`);
    project.status = 'Updating...';
    project.logs += '\nNaya commit mila. Ab update kar rahe hain...';

    try {
        // Step 1: Git pull
        console.log(`Pulling new code for ${project.name}...`);
        await executeCommand('git pull', { cwd: project.path });

        // Step 2: Restart the app with PM2
        console.log(`Restarting PM2 process for ${project.name}...`);
        const pm2RestartCommand = `pm2 restart ${project.name}`;
        await executeCommand(pm2RestartCommand);

        project.status = 'Live';
        project.logs += `\nUpdate complete. App successfully restarted and is LIVE.`;
        console.log(`Project ${project.name} successfully updated.`);
    } catch (error) {
        project.status = 'Error';
        project.logs += `\nERROR: ${error.message}`;
        console.error(`Update failed for ${project.name}:`, error);
    }
}

function executeCommand(command, options = {}) {
    return new Promise((resolve, reject) => {
        exec(command, options, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            }
            resolve(stdout);
        });
    });
}

app.listen(PORT, () => {
    console.log(`Server http://localhost:${PORT} par chal raha hai.`);
    console.log(`Webhooks ke liye, aapko GitHub par 'http://<your-public-ip>:${PORT}/webhook' URL configure karna hoga.`);
    console.log('Yeh ek simplified demo hai, production environment mein isse aur secure karna zaroori hai.');
});

