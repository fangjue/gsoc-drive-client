/**
 * @fileoverview Implements a task queue that schedules asynchronous tasks.
 * Tasks are grouped into slots. Tasks in different slots can be done
 * simultaneously without any restrictions while tasks in the same slot are
 * subject to a configurable limit of maximum parallel tasks. In addition, task
 * callbacks can return a special object indicating themselves blocked on other
 * tasks. When the blocking tasks are finished, blocked tasks will be scheduled
 * again.
 */

function TaskQueue() {
  this.tasks_ = {};
  this.blockingTasks_ = {};
  this.currentId_ = 1;
  return this;
};

/** @const */ TaskQueue.UNNAMED_TASK_PREFIX = '_unnamed_';

TaskQueue.prototype.getSlot_ = function(name) {
  if (!this.tasks_[name]) {
    this.tasks_[name] = {
      running: {},
      pending: {},
      maxParallel: 1,
    };
  }

  return this.tasks_[name];
};

TaskQueue.prototype.onTaskCompleted_ = function(slot, taskName,
    completedTaskCallback) {
  delete slot.running[taskName];
  if (this.checkBlockingTasks_(taskName))
    this.run();
  else
    this.runTasksForSlot_(slot);
  this.checkCompleted_();
};

TaskQueue.prototype.checkBlockingTasks_ = function(taskName) {
  var unblocked = false;
  dictForEach(this.blockingTasks_, function(name, details) {
    if (details.blockedOn.contains(taskName))
      details.blockedOn.remove(taskName);
    if (details.blockedOn.getLength() == 0) {
      details.slot.pending[name] = details.callback;
      delete this.blockingTasks_[name];
      unblocked = true;
    }
  }.bind(this));
  return unblocked;
};

TaskQueue.prototype.runTasksForSlot_ = function(slot) {
  for (;;) {
    var runnings = Object.keys(slot.running);
    var pendings = Object.keys(slot.pending);
    if (runnings.length >= slot.maxParallel || pendings.length == 0)
      break;

    var candidate = pendings[0];
    var callback = slot.pending[candidate];
    slot.running[candidate] = callback;
    delete slot.pending[candidate];
    // TODO: Maybe asynchronous blocking is also needed?
    var result = callback(this.onTaskCompleted_.bind(this,
        slot, candidate, callback));
    if (result && result.completed) {
      // The task has been completed synchronously.
      this.onTaskCompleted_(slot, candidate, callback);
    } else if (result && result.blockedOn) {
      slot.pending[candidate] = slot.running[candidate];
      delete slot.running[candidate];
      this.tryBlockTask(candidate, result.blockedOn);
    }
  }
};

TaskQueue.prototype.checkCompleted_ = function() {
  for (var slotName in this.tasks_) {
    var slot = this.tasks_[slotName];
    if (Object.keys(slot.running).length != 0 ||
        Object.keys(slot.pending).length != 0)
      return;
  }

  if (this.completedCallback_ && !this.completed_) {
    this.completed_ = true;
    this.completedCallback_();
  }
};

/**
 * Add a new task into the queue.
 * @param {string} slotName The name of the slot.
 * @param {string} taskName The name of the task. It mustn't be identical to any
 *     tasks that are added into this queue.
 * @param {function} callback A function that looks like this:
 *     function(callback) {
 *       // Do something asynchronously...
 *       // ...
 *       // Call |callback| when the task is done.
 *       callback();
 *       // Or... return {blockedOn: [...]} if it's blocked on other tasks.
 *       return {blockedOn: ['task1', 'task2'];
 *     }
 */
TaskQueue.prototype.queue = function(slotName, taskName, callback) {  
  this.completed_ = false;
  var slot = this.getSlot_(slotName);
  if (!taskName) {
    taskName = TaskQueue.UNNAMED_TASK_PREFIX + this.currentId_.toString();
    ++this.currentId_;
  }

  console.assert(!this.findTask_(taskName));

  slot.pending[taskName] = callback;
};

TaskQueue.prototype.findTask_ = function(taskName) {
  for(var slotName in this.tasks_) {
    var slot = this.tasks_[slotName];
    var callback;
    if (callback = slot.running[taskName])
      return {slot: slot, running: true, callback: callback};
    else if (callback = slot.pending[taskName])
      return {slot: slot, pending: true, callback: callback};
  }

  return this.blockingTasks_[taskName];
};

/**
 * Run all the tasks queued.
 * @param {function} callback Called when all tasks are done.
 */
TaskQueue.prototype.run = function(callback) {
  if (callback)
    this.completedCallback_ = callback;
  for (var slotName in this.tasks_)
    this.runTasksForSlot_(this.tasks_[slotName]);
};

/**
 * Set the maximum number of parallel tasks for a slot.
 * @param {string} slotName The name of the slot.
 * @param {integer} maxParallel The maximum number of parallel tasks.
 */
TaskQueue.prototype.setMaxParallelTasks = function(slotName, maxParallel) {
  this.getSlot_(slotName).maxParallel = maxParallel;
};

TaskQueue.prototype.tryBlockTask = function(blockedTaskName, blockedOn) {
  console.assert(blockedOn.indexOf(blockedTaskName) == -1);

  var taskInfo = this.findTask_(blockedTaskName);
  // If the blocked task is already started (either running or completed), it
  // cannot be blocked any more.
  if (!taskInfo || taskInfo.running)
    return false;

  var blockedOn = blockedOn.filter(function(taskName) {
    return this.findTask_(taskName) && taskName != blockedTaskName;
  }.bind(this));
  if (taskInfo.pending) {
    if (blockedOn.length > 0) {
      this.blockingTasks_[blockedTaskName] = {
        slot: taskInfo.slot,
        callback: taskInfo.callback,
        blockedOn: Set.fromArray(blockedOn),
      };
      delete taskInfo.slot.pending[blockedTaskName];
    }
  } else {
    Set.add.apply(taskInfo.blockedOn, blockedOn);
    return true;
  }
};
