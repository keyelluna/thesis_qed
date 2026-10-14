const express = require('express');
const router = express.Router();
const verifyToken = require('../../modules/authentication/authentication.middleware');
const notificationController = require('./notification.controller');
const { notificationOwner } = require('./notification.identity');

function authenticatedOwner(req, res, next) {
  const owner = notificationOwner(req.user);
  if (!owner) {
    return res.status(403).json({ success: false, message: 'Notification access denied.' });
  }
  req.notificationOwner = owner;
  next();
}

function ownUser(req, res, next) {
  if (req.params.userId !== req.notificationOwner) {
    return res.status(403).json({ success: false, message: 'Notification access denied.' });
  }
  next();
}

router.get('/:userId', verifyToken, authenticatedOwner, ownUser, notificationController.getNotifications);
router.patch('/:id/read', verifyToken, authenticatedOwner, notificationController.markAsRead);
router.patch('/user/:userId/read-all', verifyToken, authenticatedOwner, ownUser, notificationController.markAllAsRead);

module.exports = router;
