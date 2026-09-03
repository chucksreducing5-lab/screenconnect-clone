import UIKit

final class ViewController: UIViewController {
    @IBOutlet private weak var serverUrlField: UITextField!
    @IBOutlet private weak var sessionIdField: UITextField!
    @IBOutlet private weak var tokenField: UITextField!
    @IBOutlet private weak var saveButton: UIButton!

    override func viewDidLoad() {
        super.viewDidLoad()
        loadExisting()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        loadExisting()
    }

    @IBAction private func saveTapped(_ sender: UIButton) {
        let defaults = UserDefaults(suiteName: "group.top.helpsupport.remotesupport")
        defaults?.set(serverUrlField.text ?? "", forKey: "serverUrl")
        defaults?.set(sessionIdField.text ?? "", forKey: "sessionId")
        defaults?.set(tokenField.text ?? "", forKey: "token")
    }

    private func loadExisting() {
        let defaults = UserDefaults(suiteName: "group.top.helpsupport.remotesupport")
        serverUrlField.text = defaults?.string(forKey: "serverUrl")
        sessionIdField.text = defaults?.string(forKey: "sessionId")
        tokenField.text = defaults?.string(forKey: "token")
    }
}
